/**
 * LLM-policy preview/apply tests (PR 29 / plan #131,
 * decision Q4).
 *
 * The state-machine here lives at the token verification —
 * `proposed → diff+token → applied`. Failure modes:
 *   - signature_mismatch (token tampered) → 403
 *   - expired (>5 min) → 422
 *   - payload_mismatch (proposed changed since preview) → 422
 *   - 404 on unknown domain id
 *   - audit row written before response
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
): Promise<void> {
  fixture.gitea.responses.set("admin-pat", {
    username: "alice",
    teams: ["opencoo-admins"],
  });
}

async function seedDomain(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  slug: string = "exec",
  initial: Record<string, unknown> = {},
): Promise<{ readonly id: string }> {
  const result = await raw.query<{ id: string }>(
    `INSERT INTO domains (slug, name, locale, llm_policy) VALUES ($1, 'Test', 'en', $2::jsonb) RETURNING id`,
    [slug, JSON.stringify(initial)],
  );
  return { id: result.rows[0]!.id };
}

describe("admin-api llm-policy preview", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("returns server-computed diff + sovereignty token", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw, "exec", { thinker: { provider: "openai" } });
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/domains/${id}/llm-policy/preview`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { proposed: { thinker: { provider: "anthropic" } } },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      diff: Array<{ path: string; before: unknown; after: unknown }>;
      token: string;
      expiresAt: number;
    };
    expect(body.diff).toHaveLength(1);
    expect(body.diff[0]?.path).toBe("thinker");
    expect(body.token.split(".")).toHaveLength(3);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("preview returns empty diff when proposed === current", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const initial = { thinker: { provider: "openai" } };
    const { id } = await seedDomain(f.raw, "exec", initial);
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/domains/${id}/llm-policy/preview`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { proposed: initial },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { diff: unknown[] };
    expect(body.diff).toEqual([]);
  });

  it("404 on unknown domain id", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/domains/00000000-0000-0000-0000-000000000000/llm-policy/preview`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { proposed: {} },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("admin-api llm-policy apply", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("happy path: preview → apply → row updated + audit row written", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw, "exec", { thinker: { provider: "openai" } });
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const proposed = { thinker: { provider: "anthropic" } };

    // Preview.
    const previewRes = await f.app.inject({
      method: "POST",
      url: `/api/admin/domains/${id}/llm-policy/preview`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { proposed },
    });
    const previewBody = JSON.parse(previewRes.body) as { token: string };

    // Apply with the same proposed.
    const applyRes = await f.app.inject({
      method: "POST",
      url: `/api/admin/domains/${id}/llm-policy/apply`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { proposed, token: previewBody.token },
    });
    expect(applyRes.statusCode).toBe(200);

    // Domain row updated.
    const domainRows = await f.raw.query<{ llm_policy: Record<string, unknown> }>(
      `SELECT llm_policy FROM domains WHERE id = $1::uuid`,
      [id],
    );
    expect(domainRows.rows[0]?.llm_policy).toEqual(proposed);

    // Audit row written with the right action.
    const auditRows = await f.raw.query<{ action: string; metadata: { domain_id: string } }>(
      `SELECT action, metadata FROM admin_audit_log WHERE action = 'domain.llm_policy.apply'`,
    );
    expect(auditRows.rows.length).toBe(1);
    expect(auditRows.rows[0]?.metadata?.domain_id).toBe(id);
  });

  it("rejects apply with a tampered token (403 signature_mismatch)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw, "exec", {});
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const proposed = { thinker: { provider: "anthropic" } };
    const previewRes = await f.app.inject({
      method: "POST",
      url: `/api/admin/domains/${id}/llm-policy/preview`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { proposed },
    });
    const { token } = JSON.parse(previewRes.body) as { token: string };
    const parts = token.split(".");
    const flipped = (parts[0]!.startsWith("A") ? "B" : "A") + parts[0]!.slice(1);
    const tampered = [flipped, parts[1], parts[2]].join(".");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/domains/${id}/llm-policy/apply`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { proposed, token: tampered },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { reason: string };
    expect(body.reason).toBe("signature_mismatch");
  });

  it("rejects apply with mismatched proposed (422 payload_mismatch — replay protection)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw, "exec", {});
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const previewProposed = { thinker: { provider: "anthropic" } };
    const previewRes = await f.app.inject({
      method: "POST",
      url: `/api/admin/domains/${id}/llm-policy/preview`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { proposed: previewProposed },
    });
    const { token } = JSON.parse(previewRes.body) as { token: string };
    const tamperedProposed = { thinker: { provider: "openai" } };
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/domains/${id}/llm-policy/apply`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { proposed: tamperedProposed, token },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { reason: string };
    expect(body.reason).toBe("payload_mismatch");
  });

  it("apply requires CSRF (no token → 403)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw);
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/domains/${id}/llm-policy/apply`,
      headers: { authorization: "Bearer admin-pat", "content-type": "application/json" },
      payload: { proposed: {}, token: "x.x.x" },
    });
    expect(res.statusCode).toBe(403);
  });
});

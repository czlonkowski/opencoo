/**
 * `PATCH /api/admin/source-bindings/:id` — retention_days_override
 * + notes branches (PR-W5, phase-a appendix #15).
 *
 * Pin matrix:
 *   retention_days_override:
 *     1. 200 + audit row records prev + new + caller_username.
 *     2. 200 + noOp when value resends unchanged.
 *     3. 200 + null clears the override (back to domain default).
 *     4. 422 on out-of-range (0, >365, negative).
 *     5. 404 on unknown binding id.
 *     6. 403 without CSRF.
 *
 *   notes:
 *     7. 200 + audit row records `notes_changed: true` (NEVER the
 *        notes value itself per §3.13).
 *     8. 200 + null clears the field; audit metadata flags
 *        `cleared: true`.
 *     9. 422 on body > 4096 chars.
 *    10. 404 on unknown binding id.
 *    11. 403 without CSRF.
 *
 * The wave-14 PATCH discriminator (`allowed_paths` / `config` /
 * `enabled` / `credentials`) keeps "exactly one intent per body" —
 * a mixed body still rejects with the existing 422 path. We don't
 * re-test that here; the W1 allowed-paths test pins it for the
 * union-of-N case.
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-w5-edit-fields";

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
): Promise<void> {
  fixture.gitea.responses.set(ADMIN_PAT, {
    username: "alice",
    teams: ["opencoo-admins"],
  });
}

async function seedDomain(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
): Promise<{ readonly id: string }> {
  const r = await raw.query<{ id: string }>(
    `INSERT INTO domains (slug, name, locale, class)
     VALUES ('w5-test', 'Test', 'en', 'knowledge'::domain_class)
     RETURNING id`,
  );
  return { id: r.rows[0]!.id };
}

async function seedBinding(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  domainId: string,
  args: {
    readonly retentionDaysOverride?: number | null;
    readonly notes?: string | null;
  } = {},
): Promise<{ readonly bindingId: string }> {
  const r = await raw.query<{ id: string }>(
    `INSERT INTO sources_bindings
       (domain_id, adapter_slug, review_mode, enabled,
        allowed_paths, retention_days_override, notes)
     VALUES ($1::uuid, 'drive', 'auto'::review_mode, true,
             ARRAY['docs/**']::text[], $2, $3)
     RETURNING id::text AS id`,
    [
      domainId,
      args.retentionDaysOverride ?? null,
      args.notes ?? null,
    ],
  );
  return { bindingId: r.rows[0]!.id };
}

describe("PATCH /api/admin/source-bindings/:id — retention_days_override (PR-W5)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("200 — sets override + audit records prev + new", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw);
    const { bindingId } = await seedBinding(f.raw, domainId);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/source-bindings/${bindingId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { retention_days_override: 90 },
    });
    expect(res.statusCode).toBe(200);
    const row = await f.raw.query<{ retention_days_override: number | null }>(
      `SELECT retention_days_override FROM sources_bindings WHERE id = $1::uuid`,
      [bindingId],
    );
    expect(row.rows[0]?.retention_days_override).toBe(90);
    const audit = await f.raw.query<{
      action: string;
      metadata: {
        binding_id: string;
        prev_retention_days_override: number | null;
        new_retention_days_override: number | null;
      };
    }>(
      `SELECT action, metadata FROM admin_audit_log
        WHERE action = 'source_binding.set_retention_override'`,
    );
    expect(audit.rows[0]?.metadata.prev_retention_days_override).toBeNull();
    expect(audit.rows[0]?.metadata.new_retention_days_override).toBe(90);
  });

  it("200 — noOp when value resends unchanged (no audit row)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw);
    const { bindingId } = await seedBinding(f.raw, domainId, {
      retentionDaysOverride: 30,
    });
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/source-bindings/${bindingId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { retention_days_override: 30 },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).noOp).toBe(true);
    const audit = await f.raw.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM admin_audit_log
        WHERE action = 'source_binding.set_retention_override'`,
    );
    expect(audit.rows[0]?.n).toBe("0");
  });

  it("200 — null clears the override", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw);
    const { bindingId } = await seedBinding(f.raw, domainId, {
      retentionDaysOverride: 180,
    });
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/source-bindings/${bindingId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { retention_days_override: null },
    });
    expect(res.statusCode).toBe(200);
    const row = await f.raw.query<{ retention_days_override: number | null }>(
      `SELECT retention_days_override FROM sources_bindings WHERE id = $1::uuid`,
      [bindingId],
    );
    expect(row.rows[0]?.retention_days_override).toBeNull();
  });

  it("422 — rejects 0 / 366 (out-of-range)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw);
    const { bindingId } = await seedBinding(f.raw, domainId);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    for (const bad of [0, 366, -1]) {
      const res = await f.app.inject({
        method: "PATCH",
        url: `/api/admin/source-bindings/${bindingId}`,
        headers: {
          authorization: `Bearer ${ADMIN_PAT}`,
          "x-csrf-token": csrfToken,
          cookie: `opencoo_csrf=${cookie}`,
          "content-type": "application/json",
        },
        payload: { retention_days_override: bad },
      });
      expect(res.statusCode).toBe(422);
    }
  });

  it("404 — unknown binding id", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "PATCH",
      url: "/api/admin/source-bindings/11111111-1111-4111-9111-111111111111",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { retention_days_override: 90 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("403 — CSRF gate rejects without token", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw);
    const { bindingId } = await seedBinding(f.raw, domainId);
    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/source-bindings/${bindingId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "content-type": "application/json",
      },
      payload: { retention_days_override: 90 },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("PATCH /api/admin/source-bindings/:id — notes (PR-W5)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("200 — sets notes + audit records ONLY notes_changed (not the value)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw);
    const { bindingId } = await seedBinding(f.raw, domainId);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const secretText = "internal-context that should never enter audit metadata";
    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/source-bindings/${bindingId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { notes: secretText },
    });
    expect(res.statusCode).toBe(200);
    // Row persisted.
    const row = await f.raw.query<{ notes: string | null }>(
      `SELECT notes FROM sources_bindings WHERE id = $1::uuid`,
      [bindingId],
    );
    expect(row.rows[0]?.notes).toBe(secretText);
    // Audit row: contains the flags, NEVER the notes value (§3.13).
    const audit = await f.raw.query<{ metadata: unknown }>(
      `SELECT metadata FROM admin_audit_log
        WHERE action = 'source_binding.set_notes' ORDER BY created_at DESC LIMIT 1`,
    );
    const meta = audit.rows[0]?.metadata as {
      binding_id: string;
      notes_changed: boolean;
      cleared: boolean;
    };
    expect(meta.notes_changed).toBe(true);
    expect(meta.cleared).toBe(false);
    expect(JSON.stringify(meta)).not.toContain("internal-context");
  });

  it("200 — null clears the notes field; audit `cleared: true`", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw);
    const { bindingId } = await seedBinding(f.raw, domainId, {
      notes: "to be cleared",
    });
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/source-bindings/${bindingId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { notes: null },
    });
    expect(res.statusCode).toBe(200);
    const row = await f.raw.query<{ notes: string | null }>(
      `SELECT notes FROM sources_bindings WHERE id = $1::uuid`,
      [bindingId],
    );
    expect(row.rows[0]?.notes).toBeNull();
    const audit = await f.raw.query<{ metadata: { cleared: boolean } }>(
      `SELECT metadata FROM admin_audit_log
        WHERE action = 'source_binding.set_notes' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.metadata.cleared).toBe(true);
  });

  it("422 — body > 4096 chars", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw);
    const { bindingId } = await seedBinding(f.raw, domainId);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/source-bindings/${bindingId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { notes: "x".repeat(4097) },
    });
    expect(res.statusCode).toBe(422);
  });

  // PR-W18 — whitespace-only notes are rejected at the Zod boundary
  // (the schema now `.trim()`s before `.min(1)`). Without this, the
  // COALESCE display-label precedence in the list query treats a
  // bare space as "present", and the Sources table briefly shows
  // " " in place of the derived `adapter → domain` label.
  it("422 — whitespace-only notes are rejected after trim", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw);
    const { bindingId } = await seedBinding(f.raw, domainId);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    for (const payload of [
      { notes: " " },
      { notes: "   " },
      { notes: "\t\n " },
    ]) {
      const res = await f.app.inject({
        method: "PATCH",
        url: `/api/admin/source-bindings/${bindingId}`,
        headers: {
          authorization: `Bearer ${ADMIN_PAT}`,
          "x-csrf-token": csrfToken,
          cookie: `opencoo_csrf=${cookie}`,
          "content-type": "application/json",
        },
        payload,
      });
      expect(res.statusCode).toBe(422);
    }

    // The binding's stored notes should be untouched after the
    // rejected attempts (start state was null from seedBinding).
    const row = await f.raw.query<{ notes: string | null }>(
      `SELECT notes FROM sources_bindings WHERE id = $1::uuid`,
      [bindingId],
    );
    expect(row.rows[0]?.notes).toBeNull();
  });

  // PR-W18 — non-empty notes with surrounding whitespace are
  // accepted; the .trim() normalises them before storage so the
  // stored value matches what the operator sees in the table.
  it("200 — surrounding whitespace is trimmed before storage", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw);
    const { bindingId } = await seedBinding(f.raw, domainId);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/source-bindings/${bindingId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { notes: "  partner ops notes  " },
    });
    expect(res.statusCode).toBe(200);
    const row = await f.raw.query<{ notes: string | null }>(
      `SELECT notes FROM sources_bindings WHERE id = $1::uuid`,
      [bindingId],
    );
    expect(row.rows[0]?.notes).toBe("partner ops notes");
  });

  it("404 — unknown binding id", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "PATCH",
      url: "/api/admin/source-bindings/11111111-1111-4111-9111-111111111111",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { notes: "ghost" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("403 — CSRF gate", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw);
    const { bindingId } = await seedBinding(f.raw, domainId);
    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/source-bindings/${bindingId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "content-type": "application/json",
      },
      payload: { notes: "no-csrf" },
    });
    expect(res.statusCode).toBe(403);
  });
});

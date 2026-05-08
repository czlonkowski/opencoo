/**
 * `PATCH /api/admin/source-bindings/:id` — toggle `enabled`
 * (PR-Q10, phase-a appendix #9).
 *
 * The Sources tab drill-down modal exposes a "Disable" / "Enable"
 * action; both flip `sources_bindings.enabled` and write an audit row.
 *
 * Pin matrix:
 *   1. 200 happy: enabled=false flips the row + writes 'source_binding.update' audit row
 *   2. 200 happy: enabled=true flips the row back
 *   3. 422 on body validation failure (non-boolean enabled)
 *   4. 400 on invalid uuid
 *   5. 404 when binding id does not exist
 *   6. 401 without auth header
 *   7. 403 without CSRF token
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-binding-patch";

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
): Promise<void> {
  fixture.gitea.responses.set(ADMIN_PAT, {
    username: "alice",
    teams: ["opencoo-admins"],
  });
}

async function seedBinding(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  enabled: boolean = true,
): Promise<{ readonly bindingId: string }> {
  await raw.exec(`
    INSERT INTO domains (slug, name)
    VALUES ('test-domain-patch', 'Test')
    ON CONFLICT (slug) DO NOTHING;
  `);
  const r = await raw.query<{ id: string }>(
    `INSERT INTO sources_bindings (domain_id, adapter_slug, review_mode, enabled)
     VALUES (
       (SELECT id FROM domains WHERE slug = 'test-domain-patch' LIMIT 1),
       'drive',
       'auto'::review_mode,
       $1
     )
     RETURNING id`,
    [enabled],
  );
  return { bindingId: r.rows[0]!.id };
}

describe("admin-api PATCH /api/admin/source-bindings/:id", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("200 happy: enabled=false flips the row + writes audit", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw, true);
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
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { id: string; enabled: boolean };
    expect(body.id).toBe(bindingId);
    expect(body.enabled).toBe(false);

    // Verify the DB row was updated.
    const dbRow = await f.raw.query<{ enabled: boolean }>(
      `SELECT enabled FROM sources_bindings WHERE id = $1::uuid`,
      [bindingId],
    );
    expect(dbRow.rows[0]?.enabled).toBe(false);

    // Verify the audit log row was written.
    const auditRows = await f.raw.query<{ action: string; metadata: unknown }>(
      `SELECT action, metadata FROM admin_audit_log WHERE action = 'source_binding.update'`,
    );
    expect(auditRows.rows.length).toBe(1);
    const meta = auditRows.rows[0]!.metadata as Record<string, unknown>;
    expect(meta["binding_id"]).toBe(bindingId);
    expect(meta["prev_enabled"]).toBe(true);
    expect(meta["new_enabled"]).toBe(false);
  });

  it("200 happy: enabled=true flips a disabled binding back on", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw, false);
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
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { enabled: boolean }).enabled).toBe(true);
  });

  it("422 on non-boolean enabled body", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw, true);
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
      payload: { enabled: "yes" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("400 on invalid uuid", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: "/api/admin/source-bindings/not-a-uuid",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404 when binding id does not exist", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: "/api/admin/source-bindings/00000000-0000-0000-0000-000000000000",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
  });

  it("401 without auth header", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    const res = await f.app.inject({
      method: "PATCH",
      url: "/api/admin/source-bindings/00000000-0000-0000-0000-000000000001",
      headers: { "content-type": "application/json" },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(401);
  });

  it("403 without CSRF token", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw, true);
    // Issue a session (auth passes) but no CSRF header on the mutating call.
    await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/source-bindings/${bindingId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "content-type": "application/json",
      },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(403);
  });
});

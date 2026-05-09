/**
 * `DELETE /api/admin/domains/:id` — soft + hard delete (PR-R1,
 * phase-a appendix #10).
 *
 * Default = soft-delete (sets `disabled_at = now()`); `?hard=1`
 * = hard-delete (DELETE FROM domains, refused with 409
 * `fk_restricted` if `sources_bindings.domain_id` references the
 * domain). Re-enable on PATCH is NOT in v0.1 scope.
 *
 * Pin matrix:
 *   1. Soft happy: 204 + `disabled_at` set + audit 'domain.disable'.
 *   2. Soft TOCTOU: already-disabled row returns 404 (distinguishes
 *      from never-existed).
 *   3. Hard happy (no bindings): 204 + row gone + audit 'domain.delete'
 *      with hard:true.
 *   4. Hard with bindings: 409 fk_restricted + binding_count in body
 *      AND audit metadata; the row is NOT deleted.
 *   5. 403 without CSRF.
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-domain-delete";

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
  slug: string,
): Promise<{ readonly id: string }> {
  const r = await raw.query<{ id: string }>(
    `INSERT INTO domains (slug, name, locale)
     VALUES ($1, 'Display', 'en')
     RETURNING id`,
    [slug],
  );
  return { id: r.rows[0]!.id };
}

describe("admin-api DELETE /api/admin/domains/:id (PR-R1)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("204 soft happy: sets disabled_at; writes audit 'domain.disable'", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw, "exec-soft");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "DELETE",
      url: `/api/admin/domains/${id}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(204);

    // Row still present, but disabled_at set.
    const dbRow = await f.raw.query<{ disabled_at: Date | string | null }>(
      `SELECT disabled_at FROM domains WHERE id = $1::uuid`,
      [id],
    );
    expect(dbRow.rows.length).toBe(1);
    expect(dbRow.rows[0]?.disabled_at).not.toBeNull();

    // Audit 'domain.disable' (not 'domain.delete').
    const audit = await f.raw.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM admin_audit_log WHERE action = 'domain.disable'`,
    );
    expect(audit.rows.length).toBe(1);
    const meta = audit.rows[0]!.metadata;
    expect(meta["id"]).toBe(id);
    expect(meta["slug"]).toBe("exec-soft");
    expect(meta["caller_username"]).toBe("alice");
    expect(meta["hard"]).toBe(false);
  });

  it("404 when soft-deleting an already-disabled row (TOCTOU close vs never-existed)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw, "exec-already-soft");
    // Pre-disable directly via SQL.
    await f.raw.query(
      `UPDATE domains SET disabled_at = now() WHERE id = $1::uuid`,
      [id],
    );
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "DELETE",
      url: `/api/admin/domains/${id}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(404);

    // No spurious 'domain.disable' audit row written (TOCTOU close
    // mirrors PR-Q10b — RETURNING id detects 0 rows updated).
    const audit = await f.raw.query(
      `SELECT id FROM admin_audit_log WHERE action = 'domain.disable'`,
    );
    expect(audit.rows.length).toBe(0);
  });

  it("204 hard happy (no bindings): row is gone; audit 'domain.delete' with hard:true", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw, "exec-hard");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "DELETE",
      url: `/api/admin/domains/${id}?hard=1`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(204);

    // Row is gone.
    const dbRow = await f.raw.query(
      `SELECT id FROM domains WHERE id = $1::uuid`,
      [id],
    );
    expect(dbRow.rows.length).toBe(0);

    // Audit 'domain.delete' with hard:true and binding_count: 0.
    const audit = await f.raw.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM admin_audit_log WHERE action = 'domain.delete'`,
    );
    expect(audit.rows.length).toBe(1);
    const meta = audit.rows[0]!.metadata;
    expect(meta["id"]).toBe(id);
    expect(meta["slug"]).toBe("exec-hard");
    expect(meta["caller_username"]).toBe("alice");
    expect(meta["hard"]).toBe(true);
    expect(meta["binding_count"]).toBe(0);
  });

  it("409 fk_restricted when bindings exist; binding_count is reported and the row stays", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw, "exec-with-bindings");
    // Seed two bindings so binding_count > 1.
    await f.raw.query(
      `INSERT INTO sources_bindings (domain_id, adapter_slug, review_mode, enabled)
       VALUES ($1::uuid, 'drive', 'auto'::review_mode, true)`,
      [id],
    );
    await f.raw.query(
      `INSERT INTO sources_bindings (domain_id, adapter_slug, review_mode, enabled)
       VALUES ($1::uuid, 'asana', 'auto'::review_mode, true)`,
      [id],
    );

    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "DELETE",
      url: `/api/admin/domains/${id}?hard=1`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as {
      error: string;
      binding_count: number;
    };
    expect(body.error).toBe("fk_restricted");
    expect(body.binding_count).toBe(2);

    // Row is NOT deleted.
    const dbRow = await f.raw.query(
      `SELECT id FROM domains WHERE id = $1::uuid`,
      [id],
    );
    expect(dbRow.rows.length).toBe(1);

    // Audit row records the attempt, with hard:true + binding_count:2.
    const audit = await f.raw.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM admin_audit_log WHERE action = 'domain.delete'`,
    );
    expect(audit.rows.length).toBe(1);
    const meta = audit.rows[0]!.metadata;
    expect(meta["hard"]).toBe(true);
    expect(meta["binding_count"]).toBe(2);
  });

  it("soft-disable clears is_aggregator so the partial UNIQUE INDEX does not block promotion of a successor", async () => {
    // Operator workflow: rebuild a typo'd aggregator domain.
    // Disable current aggregator → promote a fresh one. The DB-level
    // partial UNIQUE INDEX `domains_is_aggregator_singleton` only
    // filters on `is_aggregator = true` (NOT on `disabled_at`), so
    // soft-disable MUST clear the flag to keep the slot free.
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: oldId } = await seedDomain(f.raw, "company-old");
    await f.raw.query(
      `UPDATE domains SET is_aggregator = true WHERE id = $1::uuid`,
      [oldId],
    );
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    // Soft-disable.
    const res = await f.app.inject({
      method: "DELETE",
      url: `/api/admin/domains/${oldId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(204);

    // is_aggregator was cleared on disable.
    const dbRow = await f.raw.query<{
      is_aggregator: boolean;
      disabled_at: Date | string | null;
    }>(
      `SELECT is_aggregator, disabled_at FROM domains WHERE id = $1::uuid`,
      [oldId],
    );
    expect(dbRow.rows[0]?.is_aggregator).toBe(false);
    expect(dbRow.rows[0]?.disabled_at).not.toBeNull();

    // A second domain CAN now be promoted to aggregator without
    // hitting the partial-unique-index error.
    await f.raw.query(
      `INSERT INTO domains (slug, name, locale) VALUES ('company-new', 'New', 'en')`,
    );
    await expect(
      f.raw.query(
        `UPDATE domains SET is_aggregator = true WHERE slug = 'company-new'`,
      ),
    ).resolves.toBeDefined();
  });

  it("403 without CSRF token", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw, "exec-csrf");
    // Establish a session, but omit the CSRF token header on the
    // mutating call.
    await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "DELETE",
      url: `/api/admin/domains/${id}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

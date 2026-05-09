/**
 * `PATCH /api/admin/source-bindings/:id` with `{config: {...}}`
 * body — operational settings update (PR-R2, phase-a appendix #10).
 *
 * R2 widens the existing PATCH endpoint (Q10 shipped enabled-only)
 * with a discriminated body: `{enabled}`, `{config}`, or
 * `{credentials}` — exactly one intent per request so the audit
 * trail records one verb per action.
 *
 * This file pins the `config` path:
 *   1. happy: PATCH `{config}` updates `sources_bindings.config`
 *      and writes `source_binding.config_update` audit row whose
 *      metadata carries prev/new KEY LISTS (sorted), NEVER values.
 *   2. validation failure: PATCH `{config}` violating the adapter's
 *      `bindingConfigSchema` returns 422 with adapter-issue detail.
 *   3. mixed body: `{enabled, config}` → 422 (union discriminator).
 *   4. 404 on unknown binding id.
 *   5. 403 without CSRF token.
 *   6. audit metadata never carries config VALUES — explicit
 *      stringify-search assertion.
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-binding-update-config";

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
    `INSERT INTO domains (slug, name, locale, class)
     VALUES ($1, 'Test', 'en', 'knowledge'::domain_class)
     RETURNING id`,
    [slug],
  );
  return { id: r.rows[0]!.id };
}

/** Seed an Asana binding with a starting config the test can update.
 *  Uses raw INSERT (no credential round-trip) — we're exercising the
 *  PATCH path, not POST. */
async function seedAsanaBinding(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  domainId: string,
  initialConfig: Record<string, unknown> = { projectGid: "11111" },
): Promise<{ readonly bindingId: string }> {
  const r = await raw.query<{ id: string }>(
    `INSERT INTO sources_bindings (domain_id, adapter_slug, review_mode, enabled, config)
     VALUES ($1::uuid, 'asana', 'auto'::review_mode, true, $2::jsonb)
     RETURNING id::text AS id`,
    [domainId, JSON.stringify(initialConfig)],
  );
  return { bindingId: r.rows[0]!.id };
}

describe("admin-api PATCH /api/admin/source-bindings/:id (config update, PR-R2)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("200 happy: updates config and writes audit row with KEY LISTS only", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw, "wiki-edit");
    const { bindingId } = await seedAsanaBinding(f.raw, domainId, {
      projectGid: "OLD-PROJECT",
    });
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const newConfig = {
      projectGid: "11111",
      monitoredProjectGids: ["11111", "22222"],
      snapshotMode: "off",
    };

    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/source-bindings/${bindingId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { config: newConfig },
    });
    expect(res.statusCode).toBe(200);

    // Row reflects the new config.
    const row = await f.raw.query<{ config: Record<string, unknown> }>(
      `SELECT config FROM sources_bindings WHERE id = $1::uuid`,
      [bindingId],
    );
    expect(row.rows[0]!.config).toMatchObject(newConfig);

    // Audit row written with KEY LISTS (sorted) — values absent.
    const audit = await f.raw.query<{
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, metadata FROM admin_audit_log
       WHERE action = 'source_binding.config_update'`,
    );
    expect(audit.rows).toHaveLength(1);
    const meta = audit.rows[0]!.metadata;
    expect(meta["binding_id"]).toBe(bindingId);
    expect(meta["caller_username"]).toBe("alice");
    expect(meta["prev_config_keys"]).toEqual(["projectGid"]);
    expect(meta["new_config_keys"]).toEqual(
      ["monitoredProjectGids", "projectGid", "snapshotMode"],
    );
  });

  it("audit metadata never contains config values — only key lists", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw, "wiki-edit");
    const { bindingId } = await seedAsanaBinding(f.raw, domainId, {
      projectGid: "OLD-VALUE-DO-NOT-LEAK",
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
      payload: {
        config: {
          projectGid: "NEW-VALUE-ALSO-DO-NOT-LEAK",
        },
      },
    });
    expect(res.statusCode).toBe(200);

    const audit = await f.raw.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM admin_audit_log
       WHERE action = 'source_binding.config_update'`,
    );
    expect(audit.rows).toHaveLength(1);
    const metaJson = JSON.stringify(audit.rows[0]!.metadata);
    // Neither the old NOR the new value bytes appear in the audit
    // metadata. This is the load-bearing security invariant for R2's
    // config-update path: ops IDs may be operator-internal but they
    // are out of scope for the audit row.
    expect(metaJson).not.toContain("OLD-VALUE-DO-NOT-LEAK");
    expect(metaJson).not.toContain("NEW-VALUE-ALSO-DO-NOT-LEAK");
    // No `prev_config` / `new_config` value blobs either — only the
    // key-list shape we documented.
    expect(audit.rows[0]!.metadata).not.toHaveProperty("prev_config");
    expect(audit.rows[0]!.metadata).not.toHaveProperty("new_config");
  });

  it("422 when config violates the adapter's bindingConfigSchema", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw, "wiki-edit");
    const { bindingId } = await seedAsanaBinding(f.raw, domainId);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    // Asana requires `projectGid`. Empty config trips the
    // required-field gate.
    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/source-bindings/${bindingId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { config: {} },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as {
      error: string;
      missing?: string[];
    };
    expect(body.error).toMatch(/binding_config|config_schema/);
    expect(body.missing).toContain("projectGid");
  });

  it("422 on mixed body — `{enabled, config}` rejected by union discriminator", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw, "wiki-edit");
    const { bindingId } = await seedAsanaBinding(f.raw, domainId);
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
      payload: {
        enabled: true,
        config: { projectGid: "11111" },
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("404 on unknown binding id", async () => {
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
      payload: { config: { projectGid: "11111" } },
    });
    expect(res.statusCode).toBe(404);
  });

  it("403 without CSRF token", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw, "wiki-edit");
    const { bindingId } = await seedAsanaBinding(f.raw, domainId);
    // Issue session (cookie set) but omit the CSRF header on the call.
    await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/source-bindings/${bindingId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "content-type": "application/json",
      },
      payload: { config: { projectGid: "11111" } },
    });
    expect(res.statusCode).toBe(403);
  });
});

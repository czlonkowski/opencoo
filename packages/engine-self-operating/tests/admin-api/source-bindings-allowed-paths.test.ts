/**
 * `POST /api/admin/source-bindings` + `PATCH …:id` (allowed_paths
 * branch) — PR-W1 of phase-a appendix #14.
 *
 * Layer A of wave-14's three-layer cascade (260 BullMQ
 * `ingestion.scanner.classify` failures on the design-partner
 * deployment): the runtime classifier guard
 * `assertBindingNotWildcardOnly` rejects empty/wildcard-only
 * `allowed_paths`, but no creation path populates the column — every
 * fresh binding fails at first compile. W1 closes the gap by adding
 * the field to the POST body schema, the INSERT path, and a new
 * `set_allowed_paths` PATCH branch.
 *
 * Pin matrix:
 *  POST:
 *   1. 422 on empty `allowed_paths` with `BindingConfigError` message
 *      (mirrors the runtime guard wording so operators see the same
 *      text from API and runtime).
 *   2. 422 on `["**"]` (bare wildcard).
 *   3. 422 on `["**\/foo"]` (wildcard-shape).
 *   4. 201 on valid paths; row persists the array intact.
 *  PATCH `{allowed_paths}`:
 *   5. 200 happy path + `source_binding.set_allowed_paths` audit row
 *      with prev/new arrays in metadata.
 *   6. 422 on empty `allowed_paths`.
 *   7. 422 on wildcard-shaped pattern.
 *   8. 422 on mixed body (`{enabled, allowed_paths}` — discriminator).
 *   9. 404 on unknown binding id.
 *  10. 403 without CSRF.
 *  11. 401 without auth.
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-allowed-paths";

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

async function seedDriveBinding(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  domainId: string,
  initialPaths: readonly string[] = ["docs/**"],
): Promise<{ readonly bindingId: string }> {
  const r = await raw.query<{ id: string }>(
    `INSERT INTO sources_bindings (domain_id, adapter_slug, review_mode, enabled, allowed_paths)
     VALUES ($1::uuid, 'drive', 'auto'::review_mode, true, $2::text[])
     RETURNING id::text AS id`,
    [domainId, initialPaths],
  );
  return { bindingId: r.rows[0]!.id };
}

describe("admin-api POST /api/admin/source-bindings — allowed_paths (PR-W1)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("422 on empty allowed_paths array", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-main");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/source-bindings",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        adapter_slug: "drive",
        target_domain_slug: "wiki-main",
        credentials: {
          service_account_json: "json",
          root_folder_id: "1XYZ",
        },
        config: { folderId: "1XYZ" },
        allowed_paths: [],
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("422 on bare-wildcard ['**'] with BindingConfigError message", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-main");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/source-bindings",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        adapter_slug: "drive",
        target_domain_slug: "wiki-main",
        credentials: {
          service_account_json: "json",
          root_folder_id: "1XYZ",
        },
        config: { folderId: "1XYZ" },
        allowed_paths: ["**"],
      },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: string; message?: string };
    expect(body.error).toBe("binding_allowed_paths_invalid");
    expect(body.message ?? "").toMatch(/wildcard/i);
  });

  it("422 on wildcard-shape ['**/foo']", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-main");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/source-bindings",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        adapter_slug: "drive",
        target_domain_slug: "wiki-main",
        credentials: {
          service_account_json: "json",
          root_folder_id: "1XYZ",
        },
        config: { folderId: "1XYZ" },
        allowed_paths: ["**/foo"],
      },
    });
    expect(res.statusCode).toBe(422);
    expect((JSON.parse(res.body) as { error: string }).error).toBe(
      "binding_allowed_paths_invalid",
    );
  });

  it("201 on valid paths; INSERT persists the array verbatim", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-main");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/source-bindings",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        adapter_slug: "drive",
        target_domain_slug: "wiki-main",
        credentials: {
          service_account_json: "json",
          root_folder_id: "1XYZ",
        },
        config: { folderId: "1XYZ" },
        allowed_paths: ["meetings/**", "transcripts/**"],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: string };
    const row = await f.raw.query<{ allowed_paths: string[] }>(
      `SELECT allowed_paths FROM sources_bindings WHERE id = $1::uuid`,
      [body.id],
    );
    expect(row.rows[0]!.allowed_paths).toEqual([
      "meetings/**",
      "transcripts/**",
    ]);
  });
});

describe("admin-api PATCH /api/admin/source-bindings/:id — allowed_paths (PR-W1)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("200 happy: updates allowed_paths and writes set_allowed_paths audit row", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw, "wiki-main");
    const { bindingId } = await seedDriveBinding(f.raw, domainId, [
      "docs/**",
    ]);
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
        allowed_paths: ["meetings/**", "transcripts/**", "docs/**"],
      },
    });
    expect(res.statusCode).toBe(200);

    const row = await f.raw.query<{ allowed_paths: string[] }>(
      `SELECT allowed_paths FROM sources_bindings WHERE id = $1::uuid`,
      [bindingId],
    );
    expect(row.rows[0]!.allowed_paths).toEqual([
      "meetings/**",
      "transcripts/**",
      "docs/**",
    ]);

    // Audit row with prev/new arrays.
    const audit = await f.raw.query<{
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, metadata FROM admin_audit_log
       WHERE action = 'source_binding.set_allowed_paths'`,
    );
    expect(audit.rows).toHaveLength(1);
    const meta = audit.rows[0]!.metadata;
    expect(meta["binding_id"]).toBe(bindingId);
    expect(meta["caller_username"]).toBe("alice");
    expect(meta["prev_allowed_paths"]).toEqual(["docs/**"]);
    expect(meta["new_allowed_paths"]).toEqual([
      "meetings/**",
      "transcripts/**",
      "docs/**",
    ]);
  });

  it("422 on empty allowed_paths", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw, "wiki-main");
    const { bindingId } = await seedDriveBinding(f.raw, domainId);
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
      payload: { allowed_paths: [] },
    });
    expect(res.statusCode).toBe(422);
  });

  it("422 on wildcard-shape pattern", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw, "wiki-main");
    const { bindingId } = await seedDriveBinding(f.raw, domainId);
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
      payload: { allowed_paths: ["**"] },
    });
    expect(res.statusCode).toBe(422);
    expect((JSON.parse(res.body) as { error: string }).error).toBe(
      "binding_allowed_paths_invalid",
    );
  });

  it("422 on mixed body (enabled + allowed_paths) — discriminator", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw, "wiki-main");
    const { bindingId } = await seedDriveBinding(f.raw, domainId);
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
        enabled: false,
        allowed_paths: ["docs/**"],
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
      payload: { allowed_paths: ["docs/**"] },
    });
    expect(res.statusCode).toBe(404);
  });

  it("403 without CSRF token", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw, "wiki-main");
    const { bindingId } = await seedDriveBinding(f.raw, domainId);
    await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/source-bindings/${bindingId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "content-type": "application/json",
      },
      payload: { allowed_paths: ["docs/**"] },
    });
    expect(res.statusCode).toBe(403);
  });

  it("401 without auth header", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    const res = await f.app.inject({
      method: "PATCH",
      url: "/api/admin/source-bindings/00000000-0000-0000-0000-000000000000",
      headers: { "content-type": "application/json" },
      payload: { allowed_paths: ["docs/**"] },
    });
    expect(res.statusCode).toBe(401);
  });
});

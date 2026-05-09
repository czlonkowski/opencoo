/**
 * `PATCH /api/admin/source-bindings/:id` with `{credentials: {...}}`
 * body — credential rotation (PR-R2, phase-a appendix #10).
 *
 * In-place rotation: the binding's `credentials_id` is preserved
 * and the credential row's plaintext is replaced via
 * `CredentialStore.rotate()`. The audit row carries `binding_id`
 * + `credentials_id` + `caller_username`; never plaintext or
 * parsed credential fields.
 *
 *   1. happy: PATCH `{credentials}` rotates the credential row
 *      in place; binding's `credentials_id` UNCHANGED; old
 *      plaintext no longer readable; audit row written without
 *      plaintext.
 *   2. validation failure: missing required credential field → 422.
 *   3. 404 on unknown binding id.
 *   4. 403 without CSRF token.
 *   5. audit metadata never carries plaintext or parsed credential
 *      fields — explicit assertion.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { CredentialId } from "@opencoo/shared/db";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-binding-rotate-credentials";
const OLD_PAT_PLAINTEXT = "old-asana-pat-AAAA";
const OLD_WORKSPACE_GID = "ws-old-12345";
const NEW_PAT_PLAINTEXT = "new-asana-pat-BBBB";
const NEW_WORKSPACE_GID = "ws-new-67890";

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

/** Seed a binding whose credentials_id is a real CredentialStore
 *  row written via `store.write()` so the rotate path has something
 *  to update in place. */
async function seedAsanaBindingWithCreds(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
  domainId: string,
): Promise<{
  readonly bindingId: string;
  readonly credentialsId: CredentialId;
}> {
  const credentialsId = await fixture.credentialStore.write({
    name: "asana/wiki-rotate/auth",
    schemaRef: "source-adapter:asana:auth",
    plaintext: Buffer.from(
      JSON.stringify({
        personal_access_token: OLD_PAT_PLAINTEXT,
        workspace_gid: OLD_WORKSPACE_GID,
      }),
      "utf8",
    ),
  });
  const r = await fixture.raw.query<{ id: string }>(
    `INSERT INTO sources_bindings
       (domain_id, adapter_slug, review_mode, enabled, credentials_id, config)
     VALUES ($1::uuid, 'asana', 'auto'::review_mode, true, $2::uuid,
             '{"projectGid":"11111"}'::jsonb)
     RETURNING id::text AS id`,
    [domainId, credentialsId],
  );
  return { bindingId: r.rows[0]!.id, credentialsId };
}

describe("admin-api PATCH /api/admin/source-bindings/:id (credentials rotate, PR-R2)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("200 happy: rotates plaintext in place; credentials_id UNCHANGED; old plaintext no longer readable", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw, "wiki-rotate");
    const { bindingId, credentialsId } = await seedAsanaBindingWithCreds(
      f,
      domainId,
    );
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    // Sanity: store currently decrypts to the old plaintext.
    const before = await f.credentialStore.read(credentialsId);
    expect(before.plaintext.toString("utf8")).toContain(OLD_PAT_PLAINTEXT);

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
        credentials: {
          auth: {
            personal_access_token: NEW_PAT_PLAINTEXT,
            workspace_gid: NEW_WORKSPACE_GID,
          },
          webhook_secret: { x_hook_secret: "rotate-hook-secret-zzz" },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      id: string;
      credentialsRotatedAt: string;
    };
    expect(body.id).toBe(bindingId);
    expect(body.credentialsRotatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Binding row's credentials_id is UNCHANGED — in-place rotation.
    const row = await f.raw.query<{ credentials_id: string }>(
      `SELECT credentials_id::text AS credentials_id
       FROM sources_bindings WHERE id = $1::uuid`,
      [bindingId],
    );
    expect(row.rows[0]!.credentials_id).toBe(credentialsId);

    // Old plaintext is gone — fresh decrypt now returns the new one.
    const after = await f.credentialStore.read(credentialsId);
    const afterText = after.plaintext.toString("utf8");
    expect(afterText).toContain(NEW_PAT_PLAINTEXT);
    expect(afterText).toContain(NEW_WORKSPACE_GID);
    expect(afterText).not.toContain(OLD_PAT_PLAINTEXT);
    expect(afterText).not.toContain(OLD_WORKSPACE_GID);
  });

  it("audit row is written with binding_id + credentials_id; never plaintext or parsed fields", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw, "wiki-rotate");
    const { bindingId, credentialsId } = await seedAsanaBindingWithCreds(
      f,
      domainId,
    );
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    await f.app.inject({
      method: "PATCH",
      url: `/api/admin/source-bindings/${bindingId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        credentials: {
          auth: {
            personal_access_token: NEW_PAT_PLAINTEXT,
            workspace_gid: NEW_WORKSPACE_GID,
          },
          webhook_secret: { x_hook_secret: "rotate-hook-secret-zzz" },
        },
      },
    });

    const audit = await f.raw.query<{
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, metadata FROM admin_audit_log
       WHERE action = 'source_binding.credentials_rotate'`,
    );
    expect(audit.rows).toHaveLength(1);
    const auditRow = audit.rows[0]!;
    expect(auditRow.metadata["binding_id"]).toBe(bindingId);
    expect(auditRow.metadata["credentials_id"]).toBe(credentialsId);
    expect(auditRow.metadata["caller_username"]).toBe("alice");

    // Negative invariant — load-bearing for THREAT-MODEL §3.13.
    expect(auditRow.metadata).not.toHaveProperty("plaintext");
    expect(auditRow.metadata).not.toHaveProperty("auth");
    expect(auditRow.metadata).not.toHaveProperty("credentials");
    expect(auditRow.metadata).not.toHaveProperty("webhook_secret");
    const metaJson = JSON.stringify(auditRow.metadata);
    // None of the rotation plaintext bytes appear in the metadata
    // — neither the new PAT, the new workspace gid, nor the new
    // webhook secret. The old plaintext also must not have been
    // recorded (defense in depth — there is no path that would
    // include them, but the assertion guards regressions).
    expect(metaJson).not.toContain(NEW_PAT_PLAINTEXT);
    expect(metaJson).not.toContain(NEW_WORKSPACE_GID);
    expect(metaJson).not.toContain("rotate-hook-secret-zzz");
    expect(metaJson).not.toContain(OLD_PAT_PLAINTEXT);
    expect(metaJson).not.toContain(OLD_WORKSPACE_GID);
  });

  it("422 when credentials body misses a required field", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw, "wiki-rotate");
    const { bindingId } = await seedAsanaBindingWithCreds(f, domainId);
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
        credentials: {
          // Missing `personal_access_token` (required) AND `webhook_secret`.
          auth: { workspace_gid: NEW_WORKSPACE_GID },
        },
      },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as {
      error: string;
      missing?: string[];
    };
    expect(body.error).toMatch(/credential|schema_mismatch/);
    expect(body.missing).toBeDefined();
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
      payload: {
        credentials: {
          auth: {
            personal_access_token: NEW_PAT_PLAINTEXT,
            workspace_gid: NEW_WORKSPACE_GID,
          },
          webhook_secret: { x_hook_secret: "any" },
        },
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("403 without CSRF token", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw, "wiki-rotate");
    const { bindingId } = await seedAsanaBindingWithCreds(f, domainId);
    await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/source-bindings/${bindingId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "content-type": "application/json",
      },
      payload: {
        credentials: {
          auth: {
            personal_access_token: NEW_PAT_PLAINTEXT,
            workspace_gid: NEW_WORKSPACE_GID,
          },
          webhook_secret: { x_hook_secret: "any" },
        },
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

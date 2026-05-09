/**
 * `PATCH /api/admin/source-bindings/:id` with `{credentials: {...}}`
 * body — credential rotation (PR-R2, phase-a appendix #10).
 *
 * In-place rotation: the binding's `credentials_id` (and
 * `webhook_secret_credentials_id`) is preserved and the credential
 * row's plaintext is replaced via `CredentialStore.rotate()`.
 *
 * PR-R2 review fix-up — webhook adapters now rotate the
 * `webhook_secret_credentials_id` row when the body includes a
 * `webhook_secret` half. EITHER half is optional; an empty
 * `{credentials: {}}` is rejected with 422 `credentials_empty`;
 * polling adapters reject `webhook_secret` with
 * `webhook_secret_not_supported`.
 *
 * The audit row records `binding_id` + `rotated_credentials: { auth,
 * webhook_secret }` (each id-or-null) + `caller_username`; never
 * plaintext or parsed credential fields (THREAT-MODEL §3.13).
 *
 *   1. happy: PATCH `{credentials: { auth, webhook_secret }}` rotates
 *      both rows; ids UNCHANGED; old plaintext no longer readable;
 *      audit row written without plaintext.
 *   2. partial: PATCH `{credentials: { auth }}` rotates only auth row.
 *   3. partial: PATCH `{credentials: { webhook_secret }}` rotates only
 *      webhook_secret row.
 *   4. polling adapter rejects `webhook_secret` with 422.
 *   5. empty body rejects with 422 `credentials_empty`.
 *   6. validation failure: missing required field on a submitted half → 422.
 *   7. 404 on unknown binding id.
 *   8. 403 without CSRF token.
 *   9. audit metadata never carries plaintext or parsed credential
 *      fields — explicit assertion across every rotation path.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { CredentialId } from "@opencoo/shared/db";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-binding-rotate-credentials";
const OLD_PAT_PLAINTEXT = "old-asana-pat-AAAA";
const OLD_WORKSPACE_GID = "ws-old-12345";
const OLD_HOOK_SECRET = "old-hook-secret-CCCC";
const NEW_PAT_PLAINTEXT = "new-asana-pat-BBBB";
const NEW_WORKSPACE_GID = "ws-new-67890";
const NEW_HOOK_SECRET = "new-hook-secret-DDDD";
const OLD_DRIVE_TOKEN = "old-drive-token-EEEE";
const NEW_DRIVE_TOKEN = "new-drive-token-FFFF";

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

/** Seed an asana (webhook adapter) binding with BOTH credential
 *  rows written via `store.write()` so the rotate path has the auth
 *  row AND the webhook_secret row to update in place. PR-R2 review
 *  fix-up — webhook-secret rotation requires the binding to carry
 *  `webhook_secret_credentials_id`. */
async function seedAsanaBindingWithCreds(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
  domainId: string,
): Promise<{
  readonly bindingId: string;
  readonly credentialsId: CredentialId;
  readonly webhookSecretCredentialsId: CredentialId;
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
  const webhookSecretCredentialsId = await fixture.credentialStore.write({
    name: "asana/wiki-rotate/webhook_secret",
    schemaRef: "source-adapter:asana:webhook_secret",
    plaintext: Buffer.from(
      JSON.stringify({ x_hook_secret: OLD_HOOK_SECRET }),
      "utf8",
    ),
  });
  const r = await fixture.raw.query<{ id: string }>(
    `INSERT INTO sources_bindings
       (domain_id, adapter_slug, review_mode, enabled, credentials_id,
        webhook_secret_credentials_id, config)
     VALUES ($1::uuid, 'asana', 'auto'::review_mode, true, $2::uuid, $3::uuid,
             '{"projectGid":"11111"}'::jsonb)
     RETURNING id::text AS id`,
    [domainId, credentialsId, webhookSecretCredentialsId],
  );
  return {
    bindingId: r.rows[0]!.id,
    credentialsId,
    webhookSecretCredentialsId,
  };
}

/** Seed a drive (polling adapter) binding for the polling-mode
 *  rejection / partial-rotation tests. The polling shape stores the
 *  full credential object as the `auth` half. */
async function seedDriveBindingWithCreds(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
  domainId: string,
): Promise<{
  readonly bindingId: string;
  readonly credentialsId: CredentialId;
}> {
  const credentialsId = await fixture.credentialStore.write({
    name: "drive/wiki-rotate/auth",
    schemaRef: "source-adapter:drive:auth",
    plaintext: Buffer.from(
      JSON.stringify({
        service_account_json: OLD_DRIVE_TOKEN,
        root_folder_id: "1ABC",
      }),
      "utf8",
    ),
  });
  const r = await fixture.raw.query<{ id: string }>(
    `INSERT INTO sources_bindings
       (domain_id, adapter_slug, review_mode, enabled, credentials_id, config)
     VALUES ($1::uuid, 'drive', 'auto'::review_mode, true, $2::uuid,
             '{"folderId":"1ABC"}'::jsonb)
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

  it("200 happy (webhook adapter, BOTH halves): rotates auth + webhook_secret rows in place; ids UNCHANGED; old plaintexts no longer readable", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw, "wiki-rotate");
    const { bindingId, credentialsId, webhookSecretCredentialsId } =
      await seedAsanaBindingWithCreds(f, domainId);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    // Sanity: store currently decrypts to the old plaintexts.
    const beforeAuth = await f.credentialStore.read(credentialsId);
    expect(beforeAuth.plaintext.toString("utf8")).toContain(OLD_PAT_PLAINTEXT);
    const beforeHook = await f.credentialStore.read(
      webhookSecretCredentialsId,
    );
    expect(beforeHook.plaintext.toString("utf8")).toContain(OLD_HOOK_SECRET);

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
          webhook_secret: { x_hook_secret: NEW_HOOK_SECRET },
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

    // Binding row's ids are UNCHANGED — in-place rotation.
    const row = await f.raw.query<{
      credentials_id: string;
      webhook_secret_credentials_id: string;
    }>(
      `SELECT credentials_id::text AS credentials_id,
              webhook_secret_credentials_id::text AS webhook_secret_credentials_id
       FROM sources_bindings WHERE id = $1::uuid`,
      [bindingId],
    );
    expect(row.rows[0]!.credentials_id).toBe(credentialsId);
    expect(row.rows[0]!.webhook_secret_credentials_id).toBe(
      webhookSecretCredentialsId,
    );

    // Old plaintexts are gone on BOTH rows.
    const afterAuth = await f.credentialStore.read(credentialsId);
    const afterAuthText = afterAuth.plaintext.toString("utf8");
    expect(afterAuthText).toContain(NEW_PAT_PLAINTEXT);
    expect(afterAuthText).toContain(NEW_WORKSPACE_GID);
    expect(afterAuthText).not.toContain(OLD_PAT_PLAINTEXT);
    expect(afterAuthText).not.toContain(OLD_WORKSPACE_GID);
    const afterHook = await f.credentialStore.read(webhookSecretCredentialsId);
    const afterHookText = afterHook.plaintext.toString("utf8");
    expect(afterHookText).toContain(NEW_HOOK_SECRET);
    expect(afterHookText).not.toContain(OLD_HOOK_SECRET);
  });

  it("200 partial (webhook adapter, AUTH only): rotates auth row; webhook_secret row UNCHANGED; audit records rotated_credentials.webhook_secret = null", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw, "wiki-rotate");
    const { bindingId, credentialsId, webhookSecretCredentialsId } =
      await seedAsanaBindingWithCreds(f, domainId);
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
          auth: {
            personal_access_token: NEW_PAT_PLAINTEXT,
            workspace_gid: NEW_WORKSPACE_GID,
          },
        },
      },
    });
    expect(res.statusCode).toBe(200);

    // Auth row reflects new plaintext.
    const afterAuth = await f.credentialStore.read(credentialsId);
    expect(afterAuth.plaintext.toString("utf8")).toContain(NEW_PAT_PLAINTEXT);

    // Webhook_secret row is UNCHANGED — old plaintext still readable.
    // The InMemoryCredentialStore tracks rotation in-process; the row
    // not appearing in the rotate-call sequence is the load-bearing
    // signal here.
    const afterHook = await f.credentialStore.read(webhookSecretCredentialsId);
    expect(afterHook.plaintext.toString("utf8")).toContain(OLD_HOOK_SECRET);
    expect(afterHook.plaintext.toString("utf8")).not.toContain(NEW_HOOK_SECRET);

    // Audit row records rotated_credentials.webhook_secret = null;
    // never plaintext bytes.
    const audit = await f.raw.query<{
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, metadata FROM admin_audit_log
       WHERE action = 'source_binding.credentials_rotate'`,
    );
    expect(audit.rows).toHaveLength(1);
    const meta = audit.rows[0]!.metadata as {
      rotated_credentials?: { auth?: string | null; webhook_secret?: string | null };
    };
    expect(meta.rotated_credentials).toEqual({
      auth: credentialsId,
      webhook_secret: null,
    });
    const metaJson = JSON.stringify(meta);
    expect(metaJson).not.toContain(NEW_PAT_PLAINTEXT);
    expect(metaJson).not.toContain(NEW_WORKSPACE_GID);
    expect(metaJson).not.toContain(OLD_PAT_PLAINTEXT);
    expect(metaJson).not.toContain(OLD_WORKSPACE_GID);
    expect(metaJson).not.toContain(OLD_HOOK_SECRET);
  });

  it("200 partial (webhook adapter, WEBHOOK_SECRET only): rotates webhook_secret row; auth row UNCHANGED; audit records rotated_credentials.auth = null", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw, "wiki-rotate");
    const { bindingId, credentialsId, webhookSecretCredentialsId } =
      await seedAsanaBindingWithCreds(f, domainId);
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
          webhook_secret: { x_hook_secret: NEW_HOOK_SECRET },
        },
      },
    });
    expect(res.statusCode).toBe(200);

    // Webhook_secret row reflects new plaintext.
    const afterHook = await f.credentialStore.read(webhookSecretCredentialsId);
    expect(afterHook.plaintext.toString("utf8")).toContain(NEW_HOOK_SECRET);

    // Auth row is UNCHANGED.
    const afterAuth = await f.credentialStore.read(credentialsId);
    expect(afterAuth.plaintext.toString("utf8")).toContain(OLD_PAT_PLAINTEXT);
    expect(afterAuth.plaintext.toString("utf8")).not.toContain(
      NEW_PAT_PLAINTEXT,
    );

    // Audit row.
    const audit = await f.raw.query<{
      metadata: Record<string, unknown>;
    }>(
      `SELECT metadata FROM admin_audit_log
       WHERE action = 'source_binding.credentials_rotate'`,
    );
    const meta = audit.rows[0]!.metadata as {
      rotated_credentials?: { auth?: string | null; webhook_secret?: string | null };
    };
    expect(meta.rotated_credentials).toEqual({
      auth: null,
      webhook_secret: webhookSecretCredentialsId,
    });
    const metaJson = JSON.stringify(meta);
    expect(metaJson).not.toContain(NEW_HOOK_SECRET);
    expect(metaJson).not.toContain(OLD_HOOK_SECRET);
    expect(metaJson).not.toContain(OLD_PAT_PLAINTEXT);
  });

  it("200 partial (polling adapter, AUTH only): rotates the lone credential row", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw, "wiki-rotate");
    const { bindingId, credentialsId } = await seedDriveBindingWithCreds(
      f,
      domainId,
    );
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
          auth: {
            service_account_json: NEW_DRIVE_TOKEN,
            root_folder_id: "1XYZ",
          },
        },
      },
    });
    expect(res.statusCode).toBe(200);

    const after = await f.credentialStore.read(credentialsId);
    const afterText = after.plaintext.toString("utf8");
    expect(afterText).toContain(NEW_DRIVE_TOKEN);
    expect(afterText).not.toContain(OLD_DRIVE_TOKEN);

    const audit = await f.raw.query<{
      metadata: Record<string, unknown>;
    }>(
      `SELECT metadata FROM admin_audit_log
       WHERE action = 'source_binding.credentials_rotate'`,
    );
    const meta = audit.rows[0]!.metadata as {
      rotated_credentials?: { auth?: string | null; webhook_secret?: string | null };
    };
    expect(meta.rotated_credentials).toEqual({
      auth: credentialsId,
      webhook_secret: null,
    });
    expect(JSON.stringify(meta)).not.toContain(NEW_DRIVE_TOKEN);
    expect(JSON.stringify(meta)).not.toContain(OLD_DRIVE_TOKEN);
  });

  it("422 webhook_secret_not_supported on a polling adapter", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw, "wiki-rotate");
    const { bindingId } = await seedDriveBindingWithCreds(f, domainId);
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
          webhook_secret: { x_hook_secret: "any" },
        },
      },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("webhook_secret_not_supported");
  });

  it("422 credentials_empty when no halves are submitted (no-op rotation rejected)", async () => {
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
      payload: { credentials: {} },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("credentials_empty");
  });

  it("audit row records rotated_credentials.{auth,webhook_secret} ids; never plaintext or parsed fields", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw, "wiki-rotate");
    const { bindingId, credentialsId, webhookSecretCredentialsId } =
      await seedAsanaBindingWithCreds(f, domainId);
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
          webhook_secret: { x_hook_secret: NEW_HOOK_SECRET },
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
    expect(auditRow.metadata["caller_username"]).toBe("alice");
    expect(auditRow.metadata["rotated_credentials"]).toEqual({
      auth: credentialsId,
      webhook_secret: webhookSecretCredentialsId,
    });

    // Negative invariant — load-bearing for THREAT-MODEL §3.13.
    expect(auditRow.metadata).not.toHaveProperty("plaintext");
    expect(auditRow.metadata).not.toHaveProperty("auth");
    expect(auditRow.metadata).not.toHaveProperty("credentials");
    // The top-level `webhook_secret` key is forbidden (would imply a
    // plaintext leak); `rotated_credentials.webhook_secret` is the id
    // and is asserted above.
    expect(auditRow.metadata).not.toHaveProperty("webhook_secret");
    const metaJson = JSON.stringify(auditRow.metadata);
    // None of the rotation plaintext bytes appear in the metadata
    // — neither the new PAT, the new workspace gid, nor the new
    // webhook secret. The old plaintext also must not have been
    // recorded (defense in depth — there is no path that would
    // include them, but the assertion guards regressions).
    expect(metaJson).not.toContain(NEW_PAT_PLAINTEXT);
    expect(metaJson).not.toContain(NEW_WORKSPACE_GID);
    expect(metaJson).not.toContain(NEW_HOOK_SECRET);
    expect(metaJson).not.toContain(OLD_PAT_PLAINTEXT);
    expect(metaJson).not.toContain(OLD_WORKSPACE_GID);
    expect(metaJson).not.toContain(OLD_HOOK_SECRET);
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

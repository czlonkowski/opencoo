/**
 * `/api/admin/output-channels` CRUD — PR-Z4 (phase-a appendix #12
 * G5) tests.
 *
 * Pins:
 *   - GET happy / GET empty
 *   - POST 201 happy → row INSERTed + credential persisted via
 *     CredentialStore + audit row written
 *   - POST 422 on unknown adapter slug
 *   - POST 422 on missing channel config field
 *   - POST 422 on missing credential field
 *   - POST 409 on UNIQUE (adapter_slug, name) conflict
 *   - PATCH `{enabled}` flips the row + audit + (no credential
 *     re-write)
 *   - PATCH `{config}` updates jsonb + audit
 *   - PATCH `{credentials}` rotates credential record + audit
 *   - DELETE removes row + audits + best-effort credential cleanup
 *   - DELETE 404 on unknown id
 *   - PATCH 404 on unknown id
 *   - auth + CSRF gate (401 without auth, 403 without CSRF)
 */
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";
import {
  buildOutputAdapterValidator,
  type OutputAdapterDescriptor,
  type OutputAdapterSlug,
} from "../../src/admin-api/routes/output-channels.js";

const ADMIN_PAT = "admin-pat-output-channels";

function buildStubRegistry(): Readonly<
  Record<OutputAdapterSlug, OutputAdapterDescriptor>
> {
  const channelConfigJsonSchema = {
    type: "object" as const,
    properties: {
      project_gid: { type: "string" as const },
    },
    required: ["project_gid"] as const,
  };
  const credentialJsonSchema = {
    type: "object" as const,
    properties: {
      asanaPersonalAccessToken: {
        type: "string" as const,
        secret: true,
      },
    },
    required: ["asanaPersonalAccessToken"] as const,
  };
  return {
    asana: {
      channelConfigJsonSchema,
      credentialJsonSchema,
      validateConfig: buildOutputAdapterValidator(
        z
          .object({
            project_gid: z.string().min(1),
            assignee_gid: z.string().min(1).optional(),
          })
          .strict(),
      ),
      validateCredentials: buildOutputAdapterValidator(
        z
          .object({
            asanaPersonalAccessToken: z.string().min(1),
          })
          .strict(),
      ),
    },
  };
}

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
): Promise<void> {
  fixture.gitea.responses.set(ADMIN_PAT, {
    username: "alice",
    teams: ["opencoo-admins"],
  });
}

describe("admin-api /api/admin/output-channels (PR-Z4 phase-a appendix #12 G5)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("GET returns empty rows by default", async () => {
    const f = await makeAdminFixture({
      outputChannelRegistry: buildStubRegistry(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/output-channels",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });

  it("POST 201 happy: creates row + persists credential + audits", async () => {
    const f = await makeAdminFixture({
      outputChannelRegistry: buildStubRegistry(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/output-channels",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        adapter_slug: "asana",
        name: "daily-report",
        config: { project_gid: "1234567890" },
        credentials: { asanaPersonalAccessToken: "1/abc-secret" },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);

    // Row landed in the DB
    const rowQ = await f.raw.query<{
      adapter_slug: string;
      name: string;
      enabled: boolean;
      config: Record<string, unknown>;
      credentials_id: string | null;
    }>(
      `SELECT adapter_slug, name, enabled, config, credentials_id::text AS credentials_id FROM output_channels WHERE id = $1::uuid`,
      [body.id],
    );
    const row = rowQ.rows[0]!;
    expect(row.adapter_slug).toBe("asana");
    expect(row.name).toBe("daily-report");
    expect(row.enabled).toBe(true);
    expect(row.config).toEqual({ project_gid: "1234567890" });
    expect(row.credentials_id).not.toBeNull();

    // Credential is in the in-memory store under that id, plaintext
    // includes the token bytes.
    const credText = (
      await f.credentialStore.read(row.credentials_id as never)
    ).plaintext.toString("utf8");
    expect(credText).toContain("1/abc-secret");

    // Audit row written
    const auditQ = await f.raw.query<{
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, metadata FROM admin_audit_log WHERE action = 'output_channel.create' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(auditQ.rows[0]?.action).toBe("output_channel.create");
    expect(auditQ.rows[0]?.metadata).toMatchObject({
      adapter_slug: "asana",
      name: "daily-report",
      channel_id: body.id,
      caller_username: "alice",
    });
    // Token bytes NEVER appear in audit metadata.
    expect(JSON.stringify(auditQ.rows[0]?.metadata)).not.toContain(
      "1/abc-secret",
    );
  });

  it("POST 422 on unknown adapter_slug", async () => {
    const f = await makeAdminFixture({
      outputChannelRegistry: buildStubRegistry(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/output-channels",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        adapter_slug: "slack",
        name: "x",
        config: {},
        credentials: {},
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("POST 422 on missing channel config field", async () => {
    const f = await makeAdminFixture({
      outputChannelRegistry: buildStubRegistry(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/output-channels",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        adapter_slug: "asana",
        name: "no-config",
        config: {},
        credentials: { asanaPersonalAccessToken: "1/abc" },
      },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: string; missing: string[] };
    expect(body.error).toBe("channel_config_schema_mismatch");
    expect(body.missing).toContain("project_gid");
  });

  it("POST 422 on missing credential field", async () => {
    const f = await makeAdminFixture({
      outputChannelRegistry: buildStubRegistry(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/output-channels",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        adapter_slug: "asana",
        name: "no-cred",
        config: { project_gid: "11" },
        credentials: {},
      },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("credential_schema_mismatch");
  });

  it("POST 409 on UNIQUE (adapter_slug, name) conflict", async () => {
    const f = await makeAdminFixture({
      outputChannelRegistry: buildStubRegistry(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const headers = {
      authorization: `Bearer ${ADMIN_PAT}`,
      "x-csrf-token": csrfToken,
      cookie: `opencoo_csrf=${cookie}`,
      "content-type": "application/json",
    };
    const body = {
      adapter_slug: "asana",
      name: "dupe",
      config: { project_gid: "11" },
      credentials: { asanaPersonalAccessToken: "1/abc" },
    };
    const r1 = await f.app.inject({
      method: "POST",
      url: "/api/admin/output-channels",
      headers,
      payload: body,
    });
    expect(r1.statusCode).toBe(201);
    const r2 = await f.app.inject({
      method: "POST",
      url: "/api/admin/output-channels",
      headers,
      payload: body,
    });
    expect(r2.statusCode).toBe(409);
    const j = JSON.parse(r2.body) as { error: string };
    expect(j.error).toBe("name_conflict");
  });

  it("PATCH {enabled: false} flips the row + audits, no credential rewrite", async () => {
    const f = await makeAdminFixture({
      outputChannelRegistry: buildStubRegistry(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const headers = {
      authorization: `Bearer ${ADMIN_PAT}`,
      "x-csrf-token": csrfToken,
      cookie: `opencoo_csrf=${cookie}`,
      "content-type": "application/json",
    };
    const created = await f.app.inject({
      method: "POST",
      url: "/api/admin/output-channels",
      headers,
      payload: {
        adapter_slug: "asana",
        name: "to-disable",
        config: { project_gid: "11" },
        credentials: { asanaPersonalAccessToken: "1/abc" },
      },
    });
    const { id } = JSON.parse(created.body) as { id: string };
    const patch = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/output-channels/${id}`,
      headers,
      payload: { enabled: false },
    });
    expect(patch.statusCode).toBe(200);
    const row = await f.raw.query<{ enabled: boolean }>(
      `SELECT enabled FROM output_channels WHERE id = $1::uuid`,
      [id],
    );
    expect(row.rows[0]?.enabled).toBe(false);
    // Audit row
    const audit = await f.raw.query<{
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, metadata FROM admin_audit_log WHERE action = 'output_channel.update' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.action).toBe("output_channel.update");
    expect(audit.rows[0]?.metadata).toMatchObject({
      channel_id: id,
      adapter_slug: "asana",
      changed_fields: ["enabled"],
      enabled: false,
    });
  });

  it("PATCH {config} validates + updates + audits", async () => {
    const f = await makeAdminFixture({
      outputChannelRegistry: buildStubRegistry(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const headers = {
      authorization: `Bearer ${ADMIN_PAT}`,
      "x-csrf-token": csrfToken,
      cookie: `opencoo_csrf=${cookie}`,
      "content-type": "application/json",
    };
    const created = await f.app.inject({
      method: "POST",
      url: "/api/admin/output-channels",
      headers,
      payload: {
        adapter_slug: "asana",
        name: "to-config-update",
        config: { project_gid: "11" },
        credentials: { asanaPersonalAccessToken: "1/abc" },
      },
    });
    const { id } = JSON.parse(created.body) as { id: string };
    const bad = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/output-channels/${id}`,
      headers,
      payload: { config: {} },
    });
    expect(bad.statusCode).toBe(422);
    const ok = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/output-channels/${id}`,
      headers,
      payload: { config: { project_gid: "22" } },
    });
    expect(ok.statusCode).toBe(200);
    const row = await f.raw.query<{ config: Record<string, unknown> }>(
      `SELECT config FROM output_channels WHERE id = $1::uuid`,
      [id],
    );
    expect(row.rows[0]?.config).toEqual({ project_gid: "22" });
  });

  it("PATCH {credentials} rotates credential record + audits", async () => {
    const f = await makeAdminFixture({
      outputChannelRegistry: buildStubRegistry(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const headers = {
      authorization: `Bearer ${ADMIN_PAT}`,
      "x-csrf-token": csrfToken,
      cookie: `opencoo_csrf=${cookie}`,
      "content-type": "application/json",
    };
    const created = await f.app.inject({
      method: "POST",
      url: "/api/admin/output-channels",
      headers,
      payload: {
        adapter_slug: "asana",
        name: "to-rotate",
        config: { project_gid: "11" },
        credentials: { asanaPersonalAccessToken: "1/oldsecret" },
      },
    });
    const { id } = JSON.parse(created.body) as { id: string };
    const row = await f.raw.query<{ credentials_id: string | null }>(
      `SELECT credentials_id::text AS credentials_id FROM output_channels WHERE id = $1::uuid`,
      [id],
    );
    const credId = row.rows[0]!.credentials_id as string;
    const ok = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/output-channels/${id}`,
      headers,
      payload: {
        credentials: { asanaPersonalAccessToken: "1/newsecret" },
      },
    });
    expect(ok.statusCode).toBe(200);
    // New plaintext is now in the credential store
    const credText = (
      await f.credentialStore.read(credId as never)
    ).plaintext.toString("utf8");
    expect(credText).toContain("1/newsecret");
    // Audit
    const audit = await f.raw.query<{ action: string }>(
      `SELECT action FROM admin_audit_log WHERE action = 'output_channel.credentials_rotate' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.action).toBe("output_channel.credentials_rotate");
  });

  it("DELETE removes row + audits + (best-effort) credential cleanup", async () => {
    const f = await makeAdminFixture({
      outputChannelRegistry: buildStubRegistry(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const headers = {
      authorization: `Bearer ${ADMIN_PAT}`,
      "x-csrf-token": csrfToken,
      cookie: `opencoo_csrf=${cookie}`,
      "content-type": "application/json",
    };
    const created = await f.app.inject({
      method: "POST",
      url: "/api/admin/output-channels",
      headers,
      payload: {
        adapter_slug: "asana",
        name: "to-delete",
        config: { project_gid: "11" },
        credentials: { asanaPersonalAccessToken: "1/abc" },
      },
    });
    const { id } = JSON.parse(created.body) as { id: string };
    const del = await f.app.inject({
      method: "DELETE",
      url: `/api/admin/output-channels/${id}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(del.statusCode).toBe(200);
    const row = await f.raw.query<{ id: string }>(
      `SELECT id FROM output_channels WHERE id = $1::uuid`,
      [id],
    );
    expect(row.rows).toEqual([]);
    const audit = await f.raw.query<{ action: string }>(
      `SELECT action FROM admin_audit_log WHERE action = 'output_channel.delete' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.action).toBe("output_channel.delete");
  });

  it("DELETE 404 on unknown id", async () => {
    const f = await makeAdminFixture({
      outputChannelRegistry: buildStubRegistry(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "DELETE",
      url: `/api/admin/output-channels/01234567-89ab-4def-9012-3456789abcde`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH 404 on unknown id", async () => {
    const f = await makeAdminFixture({
      outputChannelRegistry: buildStubRegistry(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/output-channels/01234567-89ab-4def-9012-3456789abcde`,
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

  it("auth + CSRF gate", async () => {
    const f = await makeAdminFixture({
      outputChannelRegistry: buildStubRegistry(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    // No auth → 401
    const r401 = await f.app.inject({
      method: "POST",
      url: "/api/admin/output-channels",
      payload: {
        adapter_slug: "asana",
        name: "x",
        config: { project_gid: "1" },
        credentials: { asanaPersonalAccessToken: "1/abc" },
      },
    });
    expect(r401.statusCode).toBe(401);
    // Auth but no CSRF → 403
    const r403 = await f.app.inject({
      method: "POST",
      url: "/api/admin/output-channels",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
      payload: {
        adapter_slug: "asana",
        name: "x",
        config: { project_gid: "1" },
        credentials: { asanaPersonalAccessToken: "1/abc" },
      },
    });
    expect(r403.statusCode).toBe(403);
  });

  it("GET /api/admin/adapters surfaces outputAdapters", async () => {
    const f = await makeAdminFixture({
      outputChannelRegistry: buildStubRegistry(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/adapters",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      adapters: unknown[];
      outputAdapters: Array<{
        slug: string;
        credentialSchema: unknown;
        channelConfigSchema: unknown;
      }>;
    };
    expect(body.outputAdapters.map((a) => a.slug)).toEqual(["asana"]);
    expect(body.outputAdapters[0]?.channelConfigSchema).toBeDefined();
    expect(body.outputAdapters[0]?.credentialSchema).toBeDefined();
  });
});

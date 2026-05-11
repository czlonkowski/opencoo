/**
 * Outputs tab + channel-binding routes (PR-Z4, phase-a appendix
 * #12 G5).
 *
 * The Outputs tab exposes operator-managed delivery channels —
 * the rows in the `output_channels` table the AgentDispatcher's
 * post-run delivery hook reads from. Without this CRUD surface
 * the only way to seed a channel was a manual INSERT, and the
 * G5 wave-12 doc names this as the missing piece.
 *
 * Routes:
 *   - `GET /api/admin/output-channels` — list every channel row
 *     (newest-first, capped at 200). The UI renders a table.
 *   - `POST /api/admin/output-channels` — create a channel.
 *     Body: `{adapter_slug, name, config, credentials}`.
 *     Validates against the per-adapter channel-config schema,
 *     encrypts the credential payload via the injected
 *     `CredentialStore`, INSERTs the row, audits.
 *   - `PATCH /api/admin/output-channels/:id` — update `enabled`,
 *     `config`, or `credentials` (mutually exclusive bodies, like
 *     `source-bindings` PATCH).
 *   - `DELETE /api/admin/output-channels/:id` — delete the row.
 *     No FK cascade — the binding's `output_channel_ids[]` array
 *     may still reference a deleted channel; the dispatcher logs
 *     + skips on the next dispatch.
 *
 * All state-changing routes require CSRF + admin-team verification
 * (via the admin-api plugin's `makeGuardedApp` wrapper).
 *
 * Audit rows are written via the standard `writeAuditLog` helper
 * with new actions: `output_channel.create`, `output_channel.update`,
 * `output_channel.credentials_rotate`, `output_channel.delete`. The
 * metadata captures `(channel_id, adapter_slug, name, caller_username)`
 * and — for `update` — the changed-field NAMES (never values).
 * Credentials NEVER appear in audit metadata; the route writes only
 * the credential_id.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { CredentialStore } from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";

import { writeAuditLog } from "../audit-log.js";
import { requireAdminContext } from "../auth.js";
import { requireCsrf } from "../csrf.js";
import { isPgUniqueViolation } from "../pg-error.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Closed set of OutputAdapter slugs the routes accept. v0.1 ships
 *  one (`asana`). Adding a slug = registering a per-adapter config
 *  validator + UI form spec; the route Zod schema picks them up
 *  via the registry below. */
export const OUTPUT_ADAPTER_SLUGS = ["asana"] as const;
export type OutputAdapterSlug = (typeof OUTPUT_ADAPTER_SLUGS)[number];

/** Per-adapter validators the routes use. Keyed by adapter slug.
 *  Each entry validates EITHER the channel config (operator
 *  per-channel form) OR the credential payload (operator's PAT /
 *  token). Bound by the routes at composition time. */
export interface OutputAdapterDescriptor {
  /** UI-renderable JSON-Schema-shape for the channel config form. */
  readonly channelConfigJsonSchema: Readonly<{
    readonly type: "object";
    readonly properties: Readonly<Record<string, Readonly<{
      readonly type: "string" | "boolean" | "number";
      readonly description?: string;
    }>>>;
    readonly required: readonly string[];
  }>;
  /** Zod validator for the channel config — runs server-side
   *  BEFORE encrypting credentials + INSERTing the row. */
  readonly validateConfig: (input: unknown) =>
    | { readonly ok: true; readonly value: Record<string, unknown> }
    | { readonly ok: false; readonly missing: readonly string[] };
  /** UI-renderable JSON-Schema-shape for the credentials form. */
  readonly credentialJsonSchema: Readonly<{
    readonly type: "object";
    readonly properties: Readonly<
      Record<
        string,
        Readonly<{
          readonly type: "string" | "boolean";
          readonly description?: string;
          readonly secret?: boolean;
        }>
      >
    >;
    readonly required: readonly string[];
  }>;
  /** Zod validator for the credentials payload. */
  readonly validateCredentials: (input: unknown) =>
    | { readonly ok: true; readonly value: Record<string, unknown> }
    | { readonly ok: false; readonly missing: readonly string[] };
}

/** Convert a Zod parse failure into the route's `missing[]` shape
 *  (path-only diagnostics; never values — values may include
 *  credential bytes per THREAT-MODEL §3.6 invariant 11). */
function zodFailToMissing(
  issues: readonly z.core.$ZodIssue[],
): readonly string[] {
  return issues.map((issue) => issue.path.map(String).join("."));
}

/** Build a validator from a Zod schema that returns the route's
 *  `{ok,value}` / `{ok:false,missing}` shape. */
function buildZodValidator<S extends z.ZodType<Record<string, unknown>>>(
  schema: S,
): OutputAdapterDescriptor["validateConfig"] {
  return (input: unknown) => {
    const parsed = schema.safeParse(input);
    if (parsed.success) {
      return { ok: true as const, value: parsed.data };
    }
    return { ok: false as const, missing: zodFailToMissing(parsed.error.issues) };
  };
}

/** PR-Z4 — re-export the validator builder so the CLI composition
 *  root can construct the per-adapter descriptor without a
 *  cross-package import of the validator helper. Aliased to a
 *  public-facing name to keep the engine's public surface narrow. */
export { buildZodValidator as buildOutputAdapterValidator };

// ─── Route Zod schemas ──────────────────────────────────────────

const adapterSlugSchema = z.enum(OUTPUT_ADAPTER_SLUGS);

const createChannelSchema = z
  .object({
    adapter_slug: adapterSlugSchema,
    name: z.string().min(1).max(120),
    config: z.record(z.string(), z.unknown()),
    credentials: z.record(z.string(), z.unknown()),
  })
  .strict();

const patchEnabledSchema = z.object({ enabled: z.boolean() }).strict();
const patchConfigSchema = z
  .object({ config: z.record(z.string(), z.unknown()) })
  .strict();
const patchCredentialsSchema = z
  .object({
    credentials: z.record(z.string(), z.unknown()),
  })
  .strict();
const patchChannelSchema = z.union([
  patchEnabledSchema,
  patchConfigSchema,
  patchCredentialsSchema,
]);

// ─── Row shape returned to the UI ───────────────────────────────

export interface OutputChannelRow {
  readonly id: string;
  readonly adapterSlug: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly config: Record<string, unknown>;
  /** ISO timestamp, normalised to a string regardless of pg / pglite
   *  return shape (the `toIso` helper from source-bindings is the
   *  same). */
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// ─── Route registration ─────────────────────────────────────────

export interface RegisterOutputChannelsRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
  /** Per-PR-Z4: production wires `DrizzleCredentialStore`; the
   *  routes encrypt the operator's submitted credentials before
   *  INSERTing the channel row. When undefined, POST/PATCH-credentials
   *  return 500 (composition-incomplete; same pattern as source-bindings). */
  readonly credentialStore?: CredentialStore;
  /** @internal Test seam — defaults to the production registry
   *  (lazy import of `@opencoo/output-asana`). Tests pass a stub
   *  to avoid the cross-package import surface. */
  readonly registry?: Readonly<
    Record<OutputAdapterSlug, OutputAdapterDescriptor>
  >;
}

export async function registerOutputChannelsRoutes(
  args: RegisterOutputChannelsRoutesArgs,
): Promise<void> {
  // PR-Z4 — the registry is supplied by the CLI composition root.
  // When undefined (boot-tolerance: no OutputAdapter package
  // available, or the composition skipped the wiring), the routes
  // register no-op stubs so the operator gets a clean 500 surface
  // instead of a 404.
  const registry = args.registry ?? null;
  if (registry === null) {
    // Lazy-import failure (e.g. the package was dropped from the
    // build). Register read-only stub routes so the operator gets
    // a clean error surface; mutations 500 (composition-incomplete).
    args.app.get("/api/admin/output-channels", async () => ({ rows: [] }));
    args.app.post(
      "/api/admin/output-channels",
      { preHandler: requireCsrf },
      async (_req, reply) =>
        reply.code(500).send({ error: "output_channels_registry_unavailable" }),
    );
    args.app.patch(
      "/api/admin/output-channels/:id",
      { preHandler: requireCsrf },
      async (_req, reply) =>
        reply.code(500).send({ error: "output_channels_registry_unavailable" }),
    );
    args.app.delete(
      "/api/admin/output-channels/:id",
      { preHandler: requireCsrf },
      async (_req, reply) =>
        reply.code(500).send({ error: "output_channels_registry_unavailable" }),
    );
    return;
  }

  // GET — list rows
  args.app.get("/api/admin/output-channels", async () => {
    const result = (await args.db.execute(sql`
      SELECT id::text  AS id,
             adapter_slug,
             name,
             enabled,
             config,
             created_at,
             updated_at
      FROM output_channels
      ORDER BY created_at DESC
      LIMIT 200
    `)) as unknown as {
      rows: Array<{
        id: string;
        adapter_slug: string;
        name: string;
        enabled: boolean;
        config: Record<string, unknown> | null;
        created_at: Date | string | null;
        updated_at: Date | string | null;
      }>;
    };
    const rows: OutputChannelRow[] = result.rows.map((r) => ({
      id: r.id,
      adapterSlug: r.adapter_slug,
      name: r.name,
      enabled: r.enabled,
      config: r.config ?? {},
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
    }));
    return { rows };
  });

  // POST — create
  args.app.post(
    "/api/admin/output-channels",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const parsed = createChannelSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: "validation_failed",
          issues: parsed.error.issues,
        });
      }
      const { adapter_slug, name, config, credentials } = parsed.data;
      const descriptor = registry[adapter_slug];
      if (descriptor === undefined) {
        return reply.code(422).send({
          error: "unknown_adapter_slug",
          adapter_slug,
        });
      }

      const cfgValidation = descriptor.validateConfig(config);
      if (!cfgValidation.ok) {
        return reply.code(422).send({
          error: "channel_config_schema_mismatch",
          missing: cfgValidation.missing,
        });
      }
      const credValidation = descriptor.validateCredentials(credentials);
      if (!credValidation.ok) {
        return reply.code(422).send({
          error: "credential_schema_mismatch",
          missing: credValidation.missing,
        });
      }

      const store = args.credentialStore;
      if (store === undefined) {
        return reply.code(500).send({
          error: "credential_store_unavailable",
        });
      }

      // Persist the credential under a stable schemaRef so a
      // future read can validate the shape.
      let credentialsId: CredentialId;
      try {
        credentialsId = await store.write({
          name: `output-channel:${adapter_slug}:${name}`,
          schemaRef: `output-adapter:${adapter_slug}:credentials`,
          plaintext: Buffer.from(
            JSON.stringify(credValidation.value),
            "utf8",
          ),
        });
      } catch (err) {
        req.log?.warn({
          msg: "output_channel.credential_store_failed",
          adapter_slug,
          err: err instanceof Error ? err.name : "unknown",
        });
        return reply.code(500).send({ error: "credential_store_failed" });
      }

      const configJson = JSON.stringify(cfgValidation.value);
      let id: string;
      try {
        const inserted = (await args.db.execute(sql`
          INSERT INTO output_channels
            (adapter_slug, name, config, credentials_id)
          VALUES (
            ${adapter_slug},
            ${name},
            ${configJson}::jsonb,
            ${credentialsId}::uuid
          )
          RETURNING id::text AS id
        `)) as unknown as { rows: Array<{ id: string }> };
        const row = inserted.rows[0];
        if (row === undefined) {
          return reply.code(500).send({ error: "insert_returned_no_row" });
        }
        id = row.id;
      } catch (err) {
        // Best-effort cleanup of the credential row.
        try {
          await store.delete(credentialsId);
        } catch (cleanupErr) {
          req.log?.warn({
            msg: "output_channel.credentials_cleanup_failed",
            adapter_slug,
            err:
              cleanupErr instanceof Error
                ? cleanupErr.message
                : String(cleanupErr),
          });
        }
        // UNIQUE (adapter_slug, name) — surface 409. pg surfaces
        // SQLSTATE 23505 on the thrown Error directly; pglite + the
        // node-postgres driver both expose `.code` (sometimes via
        // `.cause` when Drizzle wraps). Use the shared narrower so a
        // future error-shape shift doesn't silently turn 409 into 500.
        if (isPgUniqueViolation(err)) {
          return reply.code(409).send({
            error: "name_conflict",
            adapter_slug,
            name,
          });
        }
        const msg = err instanceof Error ? err.message : String(err);
        req.log?.warn({
          msg: "output_channel.insert_failed",
          adapter_slug,
          err: msg,
        });
        return reply.code(500).send({ error: "insert_failed" });
      }

      await writeAuditLog(args.db, {
        action: "output_channel.create",
        userId: ctx.userId,
        metadata: {
          channel_id: id,
          adapter_slug,
          name,
          caller_username: ctx.username,
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });

      return reply.code(201).send({ id });
    },
  );

  // PATCH — update enabled | config | credentials (mutually exclusive)
  args.app.patch(
    "/api/admin/output-channels/:id",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const id = (req.params as { id: string }).id;
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      const parsed = patchChannelSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: "validation_failed",
          issues: parsed.error.issues,
        });
      }

      const existing = (await args.db.execute(sql`
        SELECT id::text AS id, adapter_slug, name, credentials_id::text AS credentials_id
        FROM output_channels
        WHERE id = ${id}::uuid
        LIMIT 1
      `)) as unknown as {
        rows: Array<{
          id: string;
          adapter_slug: string;
          name: string;
          credentials_id: string | null;
        }>;
      };
      const row = existing.rows[0];
      if (row === undefined) {
        return reply.code(404).send({ error: "not_found", id });
      }
      const descriptor = registry[row.adapter_slug as OutputAdapterSlug];
      if (descriptor === undefined) {
        return reply.code(422).send({
          error: "unknown_adapter_slug",
          adapter_slug: row.adapter_slug,
        });
      }

      // Branch 1: {enabled}
      if ("enabled" in parsed.data) {
        const next = parsed.data.enabled;
        await args.db.execute(sql`
          UPDATE output_channels
          SET enabled = ${next}, updated_at = NOW()
          WHERE id = ${id}::uuid
        `);
        await writeAuditLog(args.db, {
          action: "output_channel.update",
          userId: ctx.userId,
          metadata: {
            channel_id: id,
            adapter_slug: row.adapter_slug,
            name: row.name,
            changed_fields: ["enabled"],
            enabled: next,
            caller_username: ctx.username,
          },
          sourceIp: req.ip,
          userAgent: req.headers["user-agent"],
        });
        return reply.code(200).send({ ok: true });
      }

      // Branch 2: {config}
      if ("config" in parsed.data) {
        const validation = descriptor.validateConfig(parsed.data.config);
        if (!validation.ok) {
          return reply.code(422).send({
            error: "channel_config_schema_mismatch",
            missing: validation.missing,
          });
        }
        const configJson = JSON.stringify(validation.value);
        await args.db.execute(sql`
          UPDATE output_channels
          SET config = ${configJson}::jsonb, updated_at = NOW()
          WHERE id = ${id}::uuid
        `);
        await writeAuditLog(args.db, {
          action: "output_channel.update",
          userId: ctx.userId,
          metadata: {
            channel_id: id,
            adapter_slug: row.adapter_slug,
            name: row.name,
            changed_fields: Object.keys(validation.value),
            caller_username: ctx.username,
          },
          sourceIp: req.ip,
          userAgent: req.headers["user-agent"],
        });
        return reply.code(200).send({ ok: true });
      }

      // Branch 3: {credentials} — rotate in place
      if ("credentials" in parsed.data) {
        const validation = descriptor.validateCredentials(
          parsed.data.credentials,
        );
        if (!validation.ok) {
          return reply.code(422).send({
            error: "credential_schema_mismatch",
            missing: validation.missing,
          });
        }
        const store = args.credentialStore;
        if (store === undefined) {
          return reply.code(500).send({ error: "credential_store_unavailable" });
        }
        if (row.credentials_id === null) {
          return reply.code(500).send({
            error: "credentials_id_missing",
            id,
          });
        }
        try {
          await store.rotate(
            row.credentials_id as CredentialId,
            Buffer.from(JSON.stringify(validation.value), "utf8"),
          );
        } catch (err) {
          req.log?.warn({
            msg: "output_channel.rotate_failed",
            channel_id: id,
            err: err instanceof Error ? err.name : "unknown",
          });
          return reply.code(500).send({ error: "rotate_failed" });
        }
        await args.db.execute(sql`
          UPDATE output_channels
          SET updated_at = NOW()
          WHERE id = ${id}::uuid
        `);
        await writeAuditLog(args.db, {
          action: "output_channel.credentials_rotate",
          userId: ctx.userId,
          metadata: {
            channel_id: id,
            adapter_slug: row.adapter_slug,
            name: row.name,
            credentials_id: row.credentials_id,
            caller_username: ctx.username,
          },
          sourceIp: req.ip,
          userAgent: req.headers["user-agent"],
        });
        return reply.code(200).send({ ok: true });
      }
      // Should be unreachable thanks to the Zod union — guard the
      // exhaustiveness defensively.
      return reply.code(422).send({ error: "validation_failed" });
    },
  );

  // DELETE — remove the row + the credential (best-effort).
  args.app.delete(
    "/api/admin/output-channels/:id",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const id = (req.params as { id: string }).id;
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      const existing = (await args.db.execute(sql`
        SELECT id::text AS id, adapter_slug, name, credentials_id::text AS credentials_id
        FROM output_channels
        WHERE id = ${id}::uuid
        LIMIT 1
      `)) as unknown as {
        rows: Array<{
          id: string;
          adapter_slug: string;
          name: string;
          credentials_id: string | null;
        }>;
      };
      const row = existing.rows[0];
      if (row === undefined) {
        return reply.code(404).send({ error: "not_found", id });
      }

      // Delete the row FIRST so the credentials FK constraint
      // (ON DELETE RESTRICT) doesn't block us when we drop the
      // credential row next. The audit-row write trails the
      // DELETE so a database failure leaves no false-positive
      // audit record.
      try {
        await args.db.execute(sql`
          DELETE FROM output_channels WHERE id = ${id}::uuid
        `);
      } catch (err) {
        req.log?.warn({
          msg: "output_channel.delete_failed",
          channel_id: id,
          err: err instanceof Error ? err.message : String(err),
        });
        return reply.code(500).send({ error: "delete_failed" });
      }

      // Best-effort cleanup of the credential row. A failure here
      // logs but doesn't block the DELETE response — the orphan
      // credential will be garbage-collected on the next operator
      // pass (v0.2 has a scheduled cleanup; v0.1 accepts the
      // orphan).
      if (row.credentials_id !== null && args.credentialStore !== undefined) {
        try {
          await args.credentialStore.delete(
            row.credentials_id as CredentialId,
          );
        } catch (err) {
          req.log?.warn({
            msg: "output_channel.credentials_cleanup_failed",
            channel_id: id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      await writeAuditLog(args.db, {
        action: "output_channel.delete",
        userId: ctx.userId,
        metadata: {
          channel_id: id,
          adapter_slug: row.adapter_slug,
          name: row.name,
          caller_username: ctx.username,
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });

      return reply.code(200).send({ ok: true });
    },
  );
}

// ─── /api/admin/adapters extension ──────────────────────────────

export interface OutputAdapterListEntry {
  readonly slug: OutputAdapterSlug;
  readonly credentialSchema: OutputAdapterDescriptor["credentialJsonSchema"];
  readonly channelConfigSchema: OutputAdapterDescriptor["channelConfigJsonSchema"];
}

export function getOutputAdapterListEntries(
  registry?: Readonly<Record<OutputAdapterSlug, OutputAdapterDescriptor>>,
): readonly OutputAdapterListEntry[] {
  if (registry === undefined) return [];
  return (Object.keys(registry) as OutputAdapterSlug[])
    .sort()
    .map((slug) => ({
      slug,
      credentialSchema: registry[slug].credentialJsonSchema,
      channelConfigSchema: registry[slug].channelConfigJsonSchema,
    }));
}

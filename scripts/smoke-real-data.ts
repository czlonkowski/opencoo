#!/usr/bin/env node
/**
 * scripts/smoke-real-data.ts (PR-M3, phase-a appendix #5;
 * scope re-expanded by PR-N2, phase-a appendix #6).
 *
 * Operator-grade probe — confirms the deployment is alive at the
 * webhook → intake → classify-enqueue layer: the management UI's
 * `/health` answers, an HMAC-signed webhook delivery is accepted,
 * a `webhook_events` row lands inline, AND the receiver's
 * direct-intake branch (PR-N2) writes an `ingestion_intake` row
 * before returning 200. The script tears down its own scaffolding
 * before exit.
 *
 * What still defers to the runbook §4 manual walk: the full chain
 * past the intake row (compile → wiki write) depends on the rest
 * of the production composition working — Compile worker, LLM
 * router, GuardAdapter, WikiAdapter — and is best verified end-to-
 * end against a real Asana / Drive binding.
 *
 * # PR-N2 scope re-expansion (vs PR-M3)
 *
 * PR-M3 deliberately dropped the intake-row poll because
 * source-webhook's `scan()` is a no-op and the periodic Scanner
 * never produced intake rows from a webhook event. PR-N2 closes
 * that gap on the receiver side: when the bound adapter exposes
 * `webhook.enrichEvents` (source-webhook does, since PR-N2) AND
 * the orchestrator wired `scannerClassifyQueue` (it does, since
 * PR-N2), the receiver inserts the intake row itself and enqueues
 * the per-document classify job inline. The smoke now polls for
 * that intake row to confirm the chain is live in production.
 *
 * The script is deliberately minimal — it talks SQL via `pg` and HTTP
 * via the global `fetch`. No new top-level deps. No engine imports
 * (cross-engine boundary stays clean for the smoke as well as for the
 * runtime).
 *
 * Usage:
 *   pnpm smoke:real-data                     # CI mode — assumes
 *                                            #   `pnpm opencoo` is
 *                                            #   already running on
 *                                            #   PORT (default 8080).
 *   pnpm smoke:real-data -- --port 8080      # explicit port
 *   pnpm smoke:real-data -- --help           # usage
 *
 * Self-boot mode (--boot) is intentionally NOT implemented in v0.1 —
 * `pnpm opencoo` is the canonical boot path and the script's reach
 * for env vars + Postgres + Redis is the same one the production
 * composition root exercises. The runbook walks the operator through
 * `pnpm opencoo` in a sibling terminal as the prereq.
 *
 * Exit codes:
 *   0 — every step green, scaffolding torn down
 *   1 — env-var assertion failed (operator action required)
 *   2 — runtime failure during the probe (named in stderr)
 *
 * The script imports `pg` from the workspace root (transitive dep
 * via packages/cli + packages/shared). No production-engine imports.
 */
import crypto from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import {
  DrizzleCredentialStore,
  loadEncryptionKey,
} from "@opencoo/shared/credential-store";
import { readWithFile } from "@opencoo/shared/engine-scaffold";
import { ConsoleLogger } from "@opencoo/shared/logger";

// ----------------------------------------------------------------------------
// Public surface (tested by tests/smoke-real-data.test.ts)
// ----------------------------------------------------------------------------

/** Required env-var names. Mirrors `production-composition.ts`'s
 *  `requireWithFile` call list. Each name is resolved with the
 *  `<NAME>` / `<NAME>_FILE` precedence the production composition root
 *  uses (`packages/shared/src/engine-scaffold/config.ts` —
 *  `readWithFile` reads the file at `_FILE` and falls back to the
 *  inline var). Round-3 fix #1: an earlier draft only checked inline
 *  env vars and would fail in Docker-secrets deployments where opencoo
 *  itself boots fine. */
export const REQUIRED_ENV_VARS = [
  "DATABASE_URL",
  "REDIS_URL",
  "ENCRYPTION_KEY",
  "GITEA_URL",
  "GITEA_PAT",
] as const;

export type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

/** Resolved env values — populated from inline env or the matching
 *  `_FILE` Docker-secret pointer. The smoke threads these through to
 *  every downstream consumer; no consumer should re-read `process.env`. */
export type ResolvedEnv = Readonly<Record<RequiredEnvVar, string>>;

/** How long we'll poll `/health` before giving up. */
export const HEALTH_TIMEOUT_MS = 30_000;
/** How long we'll wait for the webhook_events row to land.
 *  Round-2 fix #8: bumped from 5s to 10s — the receiver writes the row
 *  inline before returning 200, so the practical floor is sub-second,
 *  but cold pg pools on CI / first-boot stacks can spike to multiple
 *  seconds before the connection is acquired. 10s preserves a fast
 *  failure mode while removing the false-positive on slow first
 *  acquires. */
export const WEBHOOK_EVENT_TIMEOUT_MS = 10_000;
/** How long we'll wait for the ingestion_intake row to land
 *  (PR-N2 re-expansion). The receiver's direct-intake branch
 *  writes the row inline before returning 200, so the practical
 *  floor is also sub-second; same generous CI cap as the
 *  webhook_events poll. */
export const INTAKE_TIMEOUT_MS = 10_000;

export interface ParsedArgs {
  readonly help: boolean;
  readonly boot: boolean;
  readonly port: number;
}

/** Parse argv (excluding `node` + script path). */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let help = false;
  let boot = false;
  let port = 8080;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (a === "--boot") {
      boot = true;
      continue;
    }
    if (a === "--port" || a.startsWith("--port=")) {
      const value = a.startsWith("--port=") ? a.slice("--port=".length) : argv[++i];
      if (value === undefined || !/^\d+$/.test(value)) {
        throw new Error(`--port requires a positive integer (got: ${String(value)})`);
      }
      port = Number.parseInt(value, 10);
      continue;
    }
    throw new Error(`unknown flag: ${a} (try --help)`);
  }
  return { help, boot, port };
}

/** Resolve every required env var via the `_FILE` precedence
 *  (Docker-secrets convention). Throws if any var is missing under
 *  both the inline name and the `_FILE` variant. Returns the resolved
 *  values so the caller can pass them downstream without re-reading
 *  the env. */
export function assertEnv(env: Record<string, string | undefined>): ResolvedEnv {
  const resolved: Partial<Record<RequiredEnvVar, string>> = {};
  const missing: RequiredEnvVar[] = [];
  for (const name of REQUIRED_ENV_VARS) {
    const value = readWithFile(env, name);
    if (typeof value === "string" && value.length > 0) {
      resolved[name] = value;
    } else {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    const both = missing.map((n) => `${n} (or ${n}_FILE)`).join(", ");
    throw new Error(
      `missing required env var(s): ${both} — see docs/pilot-runbook.md`,
    );
  }
  return resolved as ResolvedEnv;
}

export interface PollOptions {
  readonly timeoutMs: number;
  readonly intervalMs: number;
  /** Optional label used in the timeout error message. */
  readonly label?: string;
}

/** Poll `predicate` every `intervalMs` until it returns a non-null
 *  value or `timeoutMs` elapses. Errors thrown by the predicate
 *  abort the loop and propagate. */
export async function pollUntil<T>(
  predicate: () => T | null | Promise<T | null>,
  opts: PollOptions,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const result = await predicate();
    if (result !== null && result !== undefined) return result;
    if (Date.now() - start >= opts.timeoutMs) {
      const what = opts.label ?? "predicate";
      throw new Error(
        `pollUntil: timed out after ${opts.timeoutMs}ms waiting for ${what}`,
      );
    }
    await sleep(opts.intervalMs);
  }
}

// ----------------------------------------------------------------------------
// Internal probe orchestration
// ----------------------------------------------------------------------------

interface ProbeContext {
  /** Resolved required env values (post-`_FILE`-precedence). */
  readonly resolved: ResolvedEnv;
  readonly args: ParsedArgs;
  readonly stdout: { write: (s: string) => boolean };
  readonly stderr: { write: (s: string) => boolean };
  readonly fetchFn: typeof globalThis.fetch;
}

const HELP_TEXT = `\
opencoo smoke:real-data — operator probe for pilot deployments

Usage:
  pnpm smoke:real-data [--port <n>]

Required env (read from .env / shell, identical to \`pnpm opencoo\`):
  DATABASE_URL, REDIS_URL, ENCRYPTION_KEY, GITEA_URL, GITEA_PAT

What it does (webhook delivery → Postgres-row verification):
  1. Asserts the env above is set.
  2. Polls http://localhost:<port>/health (default 8080) for ${HEALTH_TIMEOUT_MS / 1000}s.
  3. Provisions a transient test domain + a generic-webhook source binding.
  4. Posts a fixture HMAC-signed event to /webhooks/<binding-id>.
  5. Confirms the row landed in webhook_events (Postgres poll).
  6. Confirms an ingestion_intake row landed (Postgres poll). The PR-N2
     direct-intake branch fires when the bound adapter exposes
     enrichEvents — source-webhook does, since PR-N2.
  7. Tears down the test scaffolding and exits 0.

Scope:
  Steps 5–6 verify webhook delivery → \`webhook_events\` row →
  \`ingestion_intake\` row via Postgres polling. The probe does NOT
  inspect Redis / BullMQ — the \`ingestion.scanner.classify\` job is
  enqueued by the same code path that writes the intake row, but
  this script does not poll the queue itself; that's a separate
  Redis check. The probe also does NOT verify compile → wiki write
  (depends on the Compile worker, LLM router, GuardAdapter, and
  WikiAdapter all being composed and reachable). To verify the full
  chain end-to-end through compile → wiki write, bind a real Asana /
  Drive source and follow the manual walk in
  docs/pilot-runbook.md §4.

Exit codes:
  0  every step green
  1  env-var assertion failed
  2  runtime failure (line in stderr names the step)
`;

async function pollHealth(ctx: ProbeContext): Promise<void> {
  const url = `http://localhost:${ctx.args.port}/health`;
  await pollUntil(
    async () => {
      try {
        const res = await ctx.fetchFn(url);
        return res.ok ? true : null;
      } catch {
        return null;
      }
    },
    { timeoutMs: HEALTH_TIMEOUT_MS, intervalMs: 2_000, label: `${url} 200` },
  );
  ctx.stdout.write(`smoke: /health ok\n`);
}

interface Scaffolding {
  readonly domainId: string;
  readonly domainSlug: string;
  readonly bindingId: string;
  readonly webhookSecret: string;
  readonly credentialId: string;
}

async function provisionScaffolding(
  pool: pg.Pool,
  ctx: ProbeContext,
): Promise<Scaffolding> {
  // The credential row goes through `DrizzleCredentialStore.write` —
  // identical encrypt path to the production composition root
  // (packages/cli/src/provision/production-composition.ts:170-176).
  // Round-2 fix #1: a raw SQL INSERT into `credentials` was schemaless
  // (no `provider`/`payload` columns) AND would have stored a plaintext
  // secret the receiver's `credentialStore.read()` could not decrypt
  // (aad mismatch → IntegrityError before HMAC verification).
  //
  // Domain + sources_bindings rows still go in via raw SQL — those
  // tables have no encryption surface and the admin-API requires CSRF
  // + admin-team membership the smoke deliberately avoids.
  const stamp = Date.now();
  const domainSlug = `smoke-${stamp}`;
  const webhookSecret = crypto.randomBytes(32).toString("hex");

  // Construct the credential store with the operator's vault key.
  // Round-3 fix #1: feed `loadEncryptionKey` a synthesized env with
  // ONLY `ENCRYPTION_KEY` populated from the post-`_FILE`-precedence
  // resolved value. The loader's own `_FILE` lookup is then a no-op
  // (we already resolved it), but we still get its base64-decode +
  // 32-byte length validation.
  const credentialStore = new DrizzleCredentialStore({
    db: drizzle(pool) as unknown as ConstructorParameters<
      typeof DrizzleCredentialStore
    >[0]["db"],
    key: loadEncryptionKey({
      ENCRYPTION_KEY: ctx.resolved.ENCRYPTION_KEY,
    } as NodeJS.ProcessEnv),
    logger: new ConsoleLogger(),
  });
  // Order: credential first (FK target for sources_bindings.credentials_id
  // with onDelete: restrict — the binding INSERT cannot reference an
  // id that doesn't yet exist). Round-3 fix #2: wrap the
  // post-credential-write logic in a try/catch that explicitly cleans
  // up the credential row if the domain/binding INSERT throws.
  // Without this, a partial-provisioning failure would leak the
  // credential row — `provisionScaffolding` rethrows before
  // `Scaffolding` is constructed, so the outer `finally` in `run()`
  // never reaches `teardown()` (it gates on `scaffold !== undefined`).
  //
  // PR-Q7: the credential plaintext mirrors the admin-API
  // source-bindings write path (encryptBindingCredentials): the FULL
  // `webhook_secret` object is JSON.stringify'd and stored, NOT the
  // raw secret bytes. The receiver then unwraps it via the bound
  // adapter's `extractWebhookSecret` helper before calling the HMAC
  // verifier. The generic webhook adapter (this smoke uses
  // adapter_slug='webhook') extracts `signing_secret` per
  // `SOURCE_ADAPTER_CREDENTIAL_SCHEMAS.webhook.credentialSchema.properties.webhook_secret`.
  // Pre-Q7 the smoke wrote raw bytes here; that worked only because
  // the receiver also passed raw bytes through to the verifier — a
  // real Asana / Fireflies webhook would have failed signature
  // verification under that scheme.
  const credentialId = await credentialStore.write({
    name: `smoke:webhook-secret:${stamp}`,
    schemaRef: "smoke:webhook_secret",
    plaintext: Buffer.from(
      JSON.stringify({ signing_secret: webhookSecret }),
      "utf8",
    ),
  });

  let domainId: string;
  let bindingId: string;
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: domainRows } = await client.query<{ id: string }>(
        `INSERT INTO domains (slug, name, class)
         VALUES ($1, $1, 'knowledge')
         RETURNING id`,
        [domainSlug],
      );
      domainId = domainRows[0]!.id;

      const { rows: bindingRows } = await client.query<{ id: string }>(
        `INSERT INTO sources_bindings
           (domain_id, adapter_slug, credentials_id, webhook_secret_credentials_id,
            config, enabled, review_mode)
         VALUES ($1, 'webhook', $2, $2, $3::jsonb, true, 'auto')
         RETURNING id`,
        [
          domainId,
          credentialId,
          JSON.stringify({
            pathSegment: `smoke-${stamp}`,
          }),
        ],
      );
      bindingId = bindingRows[0]!.id;

      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    // Domain or binding INSERT failed (most likely: schema-missing,
    // duplicate slug, or pool-acquisition error). The credential row
    // is now an orphan — no FK references it, but it leaks until
    // someone runs psql. Clean it up before rethrowing so a smoke
    // failure leaves nothing behind.
    await credentialStore.delete(credentialId).catch((cleanupErr: unknown) => {
      ctx.stderr.write(
        `smoke: orphaned credential cleanup failed (${
          (cleanupErr as Error).message
        }) — psql DELETE FROM credentials WHERE id = '${credentialId}'\n`,
      );
    });
    throw err;
  }

  ctx.stdout.write(
    `smoke: scaffolding ok (domain=${domainSlug} binding=${bindingId})\n`,
  );
  return { domainId, domainSlug, bindingId, webhookSecret, credentialId };
}

async function postFixtureWebhook(
  scaffold: Scaffolding,
  ctx: ProbeContext,
): Promise<void> {
  const url = `http://localhost:${ctx.args.port}/webhooks/${scaffold.bindingId}`;
  const body = JSON.stringify({
    smoke: true,
    eventId: `smoke-${Date.now()}`,
    payload: { hello: "pilot" },
  });
  const signature = crypto
    .createHmac("sha256", scaffold.webhookSecret)
    .update(body)
    .digest("hex");
  const res = await ctx.fetchFn(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature": `sha256=${signature}`,
      "x-event-id": `smoke-${Date.now()}`,
      "x-provider": "smoke",
    },
    body,
  });
  // 401 from the receiver means HMAC verification failed. Since round-2
  // fix #1, the smoke writes the credential through the same
  // `DrizzleCredentialStore` the receiver reads from, so a 401 here
  // is a real product bug worth surfacing to the operator (likely:
  // ENCRYPTION_KEY rotated mid-flight, or the receiver's verifier is
  // misconfigured). Either way, no quiet pass-through.
  if (res.status === 401) {
    throw new Error(
      `webhook POST returned 401 (signature mismatch) — the smoke signed` +
        ` with the same secret it wrote via CredentialStore.write; check the` +
        ` engine's webhook receiver for HMAC misconfiguration.`,
    );
  }
  if (!res.ok) {
    throw new Error(`webhook POST returned ${res.status}`);
  }
  ctx.stdout.write(`smoke: webhook posted (binding=${scaffold.bindingId})\n`);
}

async function awaitWebhookEvent(
  pool: pg.Pool,
  scaffold: Scaffolding,
  ctx: ProbeContext,
): Promise<void> {
  await pollUntil(
    async () => {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM webhook_events
         WHERE binding_id = $1
         ORDER BY received_at DESC
         LIMIT 1`,
        [scaffold.bindingId],
      );
      return rows[0] ?? null;
    },
    {
      timeoutMs: WEBHOOK_EVENT_TIMEOUT_MS,
      intervalMs: 250,
      label: "webhook_events row",
    },
  );
  ctx.stdout.write(`smoke: webhook_events row landed\n`);
}

async function awaitIntakeRow(
  pool: pg.Pool,
  scaffold: Scaffolding,
  ctx: ProbeContext,
): Promise<void> {
  // PR-N2: the receiver's direct-intake branch (fires when the
  // bound adapter exposes `webhook.enrichEvents` AND the
  // orchestrator wired `scannerClassifyQueue`) writes the
  // `ingestion_intake` row inline before returning 200.
  // source-webhook satisfies both prerequisites since PR-N2, so a
  // fresh smoke binding produces a row visible immediately.
  await pollUntil(
    async () => {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM ingestion_intake
         WHERE binding_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [scaffold.bindingId],
      );
      return rows[0] ?? null;
    },
    {
      timeoutMs: INTAKE_TIMEOUT_MS,
      intervalMs: 250,
      label: "ingestion_intake row",
    },
  );
  ctx.stdout.write(`smoke: ingestion_intake row landed\n`);
}

async function teardown(
  pool: pg.Pool,
  scaffold: Scaffolding,
  ctx: ProbeContext,
): Promise<void> {
  // Best-effort delete in reverse FK order. Errors here are warnings,
  // not failures — the smoke ALREADY succeeded; leaving stray rows is
  // an operator-visible nuisance, not a smoke failure.
  //
  // FK shape (verified in
  // packages/shared/src/db/schema/sources-bindings.ts:34-49):
  //   sources_bindings.credentials_id              uuid → credentials.id  ON DELETE RESTRICT
  //   sources_bindings.webhook_secret_credentials_id  uuid → credentials.id  ON DELETE RESTRICT
  //   sources_bindings.domain_id                   uuid → domains.id      (FK)
  //   webhook_events.binding_id                    uuid → sources_bindings.id (FK)
  //
  // So the order MUST be: webhook_events → sources_bindings → credentials
  // → domains. Deleting credentials before sources_bindings would trip
  // the RESTRICT and leave the smoke binding behind on cleanup retry.
  // Round-3 fix #4: an earlier comment claimed the credentials_id
  // column was "unconstrained text" — wrong; it's uuid with RESTRICT.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // PR-N2: ingestion_intake DELETE is now load-bearing — the
    // receiver's direct-intake branch (fired when the bound adapter
    // exposes `webhook.enrichEvents`) writes one intake row per
    // delivery for this binding. Without this DELETE, the smoke
    // would leak rows on every run. The order matters: intake rows
    // FK to sources_bindings, so this must precede the bindings
    // DELETE below.
    await client.query("DELETE FROM ingestion_intake WHERE binding_id = $1", [
      scaffold.bindingId,
    ]);
    await client.query("DELETE FROM webhook_events WHERE binding_id = $1", [
      scaffold.bindingId,
    ]);
    await client.query("DELETE FROM sources_bindings WHERE id = $1", [
      scaffold.bindingId,
    ]);
    await client.query("DELETE FROM credentials WHERE id = $1", [
      scaffold.credentialId,
    ]);
    await client.query("DELETE FROM domains WHERE id = $1", [scaffold.domainId]);
    await client.query("COMMIT");
    ctx.stdout.write(`smoke: scaffolding torn down\n`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    ctx.stderr.write(
      `smoke: teardown warning (${(err as Error).message}) — manual psql cleanup may be needed\n`,
    );
  } finally {
    client.release();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----------------------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------------------

export interface RunArgs {
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly stdout: { write: (s: string) => boolean };
  readonly stderr: { write: (s: string) => boolean };
  /** @internal Test seam — defaults to global fetch. */
  readonly fetchFn?: typeof globalThis.fetch;
  /** @internal Test seam — defaults to a real `pg.Pool`. */
  readonly poolFactory?: (databaseUrl: string) => pg.Pool;
}

export async function run(args: RunArgs): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args.argv);
  } catch (err) {
    args.stderr.write(`smoke: ${(err as Error).message}\n`);
    return 1;
  }
  if (parsed.help) {
    args.stdout.write(HELP_TEXT);
    return 0;
  }
  let resolved: ResolvedEnv;
  try {
    resolved = assertEnv(args.env);
  } catch (err) {
    args.stderr.write(`smoke: ${(err as Error).message}\n`);
    return 1;
  }
  if (parsed.boot) {
    args.stderr.write(
      `smoke: --boot is not implemented in v0.1 — start \`pnpm opencoo\` in another terminal first\n`,
    );
    return 1;
  }
  const ctx: ProbeContext = {
    resolved,
    args: parsed,
    stdout: args.stdout,
    stderr: args.stderr,
    fetchFn: args.fetchFn ?? globalThis.fetch,
  };
  const pool = (args.poolFactory ?? ((u): pg.Pool => new pg.Pool({ connectionString: u })))(
    resolved.DATABASE_URL,
  );
  let scaffold: Scaffolding | undefined;
  try {
    await pollHealth(ctx);
    scaffold = await provisionScaffolding(pool, ctx);
    await postFixtureWebhook(scaffold, ctx);
    await awaitWebhookEvent(pool, scaffold, ctx);
    await awaitIntakeRow(pool, scaffold, ctx);
    args.stdout.write(
      `smoke: green (webhook → intake → classify-enqueue chain)\n`,
    );
    return 0;
  } catch (err) {
    args.stderr.write(`smoke: ${(err as Error).message}\n`);
    return 2;
  } finally {
    if (scaffold !== undefined) {
      await teardown(pool, scaffold, ctx);
    }
    await pool.end().catch(() => undefined);
  }
}

// ----------------------------------------------------------------------------
// CLI bootstrap (only when run as a script, not when imported by tests)
// ----------------------------------------------------------------------------

const isDirectlyExecuted = (() => {
  if (typeof process === "undefined") return false;
  const arg1 = process.argv[1] ?? "";
  return arg1.endsWith("smoke-real-data.ts") || arg1.endsWith("smoke-real-data.js");
})();

if (isDirectlyExecuted) {
  const code = await run({
    argv: process.argv.slice(2),
    env: process.env as Record<string, string | undefined>,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.exit(code);
}

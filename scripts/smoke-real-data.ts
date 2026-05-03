#!/usr/bin/env node
/**
 * scripts/smoke-real-data.ts (PR-M3, phase-a appendix #5).
 *
 * Operator-grade probe — confirms the deployment is alive at the
 * webhook-receiver layer: the management UI's `/health` answers, an
 * HMAC-signed webhook delivery is accepted, the row lands in
 * `webhook_events`, and the script tears down its own scaffolding
 * before exit. **The smoke does NOT verify the full ingestion pipeline**
 * — `source-webhook.scan()` is a no-op by design
 * (`packages/adapters/source-webhook/src/adapter.ts:263-268`), so the
 * Scanner pipeline never produces an `ingestion_intake` row from a
 * webhook event for this adapter. Verifying the full webhook → intake
 * → compile → wiki chain requires an adapter whose `scan()` produces
 * documents (Asana, Drive); the runbook §4 walks that path against a
 * real binding.
 *
 * Round-3 fix #3: an earlier draft of this script polled for an
 * `ingestion_intake` row after posting the webhook and would
 * always time out for the reason above. Scope narrowed to
 * "webhook delivery → DB persistence" only; the full-chain verification
 * is the runbook walk against Asana, not this script.
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
import { ConsoleLogger } from "@opencoo/shared/logger";

// ----------------------------------------------------------------------------
// Public surface (tested by tests/smoke-real-data.test.ts)
// ----------------------------------------------------------------------------

/** Required env-var names. Mirrors `production-composition.ts`'s
 *  `requireWithFile` call list. The smoke considers an env var
 *  "present" when its value is a non-empty string. */
export const REQUIRED_ENV_VARS = [
  "DATABASE_URL",
  "REDIS_URL",
  "ENCRYPTION_KEY",
  "GITEA_URL",
  "GITEA_PAT",
] as const;

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

/** Throw if any required env var is missing or empty. */
export function assertEnv(env: Record<string, string | undefined>): void {
  const missing = REQUIRED_ENV_VARS.filter((k) => {
    const v = env[k];
    return typeof v !== "string" || v.length === 0;
  });
  if (missing.length > 0) {
    throw new Error(
      `missing required env var(s): ${missing.join(", ")} — see docs/pilot-runbook.md`,
    );
  }
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
  readonly env: Record<string, string | undefined>;
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

What it does (webhook-receiver layer only):
  1. Asserts the env above is set.
  2. Polls http://localhost:<port>/health (default 8080) for ${HEALTH_TIMEOUT_MS / 1000}s.
  3. Provisions a transient test domain + a generic-webhook source binding.
  4. Posts a fixture HMAC-signed event to /webhooks/<binding-id>.
  5. Confirms the row landed in webhook_events.
  6. Tears down the test scaffolding and exits 0.

Scope:
  This probe verifies the HTTP receiver + HMAC verify + DB persistence
  path. It does NOT verify the full webhook → intake → compile → wiki
  chain, because the generic source-webhook adapter's scan() is a no-op
  by design — Scanner only enqueues documents it can fetch, and webhook
  adapters push events without a scannable source. To verify the full
  chain end-to-end, bind a real Asana / Drive source and follow the
  manual walk in docs/pilot-runbook.md §4.

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
  // `loadEncryptionKey` requires a NodeJS.ProcessEnv shape.
  const credentialStore = new DrizzleCredentialStore({
    db: drizzle(pool) as unknown as ConstructorParameters<
      typeof DrizzleCredentialStore
    >[0]["db"],
    key: loadEncryptionKey(ctx.env as NodeJS.ProcessEnv),
    logger: new ConsoleLogger(),
  });
  const credentialId = await credentialStore.write({
    name: `smoke:webhook-secret:${stamp}`,
    schemaRef: "smoke:webhook_secret",
    plaintext: Buffer.from(webhookSecret, "utf8"),
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: domainRows } = await client.query<{ id: string }>(
      `INSERT INTO domains (slug, name, class)
       VALUES ($1, $1, 'knowledge')
       RETURNING id`,
      [domainSlug],
    );
    const domainId = domainRows[0]!.id;

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
    const bindingId = bindingRows[0]!.id;

    await client.query("COMMIT");
    ctx.stdout.write(
      `smoke: scaffolding ok (domain=${domainSlug} binding=${bindingId})\n`,
    );
    return { domainId, domainSlug, bindingId, webhookSecret, credentialId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
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

async function teardown(
  pool: pg.Pool,
  scaffold: Scaffolding,
  ctx: ProbeContext,
): Promise<void> {
  // Best-effort delete in reverse FK order. Errors here are warnings,
  // not failures — the smoke ALREADY succeeded; leaving stray rows is
  // an operator-visible nuisance, not a smoke failure.
  //
  // The credential row carries no FK from sources_bindings (the
  // `credentials_id` column is unconstrained text), so order here is
  // safe: bindings first (FK to domain), then DELETE FROM credentials,
  // then domain.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Round-3 fix #3: no ingestion_intake DELETE — source-webhook's
    // scan() is a no-op so the Scanner never inserts intake rows for
    // this binding. Defensive DELETE retained as a safety net in case
    // a future operator binds the smoke fixture to an adapter that
    // does scan; cost is one trivial WHERE-no-rows query.
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
  try {
    assertEnv(args.env);
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
    env: args.env,
    args: parsed,
    stdout: args.stdout,
    stderr: args.stderr,
    fetchFn: args.fetchFn ?? globalThis.fetch,
  };
  const pool = (args.poolFactory ?? ((u): pg.Pool => new pg.Pool({ connectionString: u })))(
    args.env["DATABASE_URL"]!,
  );
  let scaffold: Scaffolding | undefined;
  try {
    await pollHealth(ctx);
    scaffold = await provisionScaffolding(pool, ctx);
    await postFixtureWebhook(scaffold, ctx);
    await awaitWebhookEvent(pool, scaffold, ctx);
    args.stdout.write(`smoke: green (webhook-receiver layer)\n`);
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

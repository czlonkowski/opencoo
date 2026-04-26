/**
 * Phase-a e2e seed (PR 32 / plan #149).
 *
 * Two responsibilities:
 *
 *   1. ONE-TIME-PER-PROCESS bootstrap (`bootstrapEnvironment`):
 *      apply Drizzle migrations to the e2e Postgres, create
 *      the Gitea admin user via `gitea admin user create`, mint
 *      a PAT via the Gitea API. The admin PAT is RETURNED, never
 *      written to disk — every caller threads it through (planner
 *      Q9: never persisted).
 *
 *   2. PER-TEST reset (`resetForTest`): truncate the mutable
 *      Postgres tables, recreate the per-domain Gitea wiki
 *      repo. Keeps wall-clock under the 10-min budget by
 *      reusing the compose stack across all three tests
 *      (planner Q4) instead of paying a full bring-up per test.
 *
 * Drizzle migration runner is reused via direct invocation —
 * `migrate(drizzle(pool), {migrationsFolder})` — same call the
 * `opencoo migrate` CLI verb runs. This means the e2e suite
 * exercises the SAME schema artefacts that ship in the published
 * `@opencoo/shared` package.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import {
  drizzle,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";

import { E2E_ENDPOINTS } from "./compose-controller.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ADMIN_USER = "opencoo-e2e";
const ADMIN_PW = "opencoo-e2e-pw";
const ADMIN_EMAIL = "opencoo-e2e@opencoo.test";
const PAT_NAME = "opencoo-e2e-pat";
const GITEA_CONTAINER = "opencoo-e2e-gitea";

/** Resolved bootstrap result. The PAT is the lifeblood of every
 *  Gitea-touching test step — kept in memory only. */
export interface E2EEnvironment {
  readonly pgPool: pg.Pool;
  /** Drizzle-wrapped pg.Pool — production pipelines accept the
   *  Drizzle handle, not the raw pool. Tests that need raw SQL
   *  (e.g. seeding, assertions) use `pgPool.query` directly. */
  readonly db: NodePgDatabase;
  readonly giteaBaseUrl: string;
  readonly giteaAdminUser: string;
  readonly giteaAdminPat: string;
}

let cachedEnv: E2EEnvironment | null = null;

function migrationsFolder(): string {
  // tests/e2e/_setup → packages/shared/drizzle
  return join(__dirname, "..", "..", "..", "packages", "shared", "drizzle");
}

async function applyMigrations(pool: pg.Pool): Promise<void> {
  const db = drizzle(pool);
  await drizzleMigrate(db, { migrationsFolder: migrationsFolder() });
}

/**
 * Idempotent admin-user creation via `gitea admin user create`
 * inside the container. The CLI emits `user already exists` on a
 * second call; we tolerate that one specific error and treat any
 * other failure as fatal (so a broken Gitea image doesn't
 * silently produce a no-PAT-available run).
 */
function ensureAdminUser(): void {
  const res = spawnSync(
    "docker",
    [
      "exec",
      "-u",
      "git",
      GITEA_CONTAINER,
      "gitea",
      "admin",
      "user",
      "create",
      "--admin",
      "--username",
      ADMIN_USER,
      "--password",
      ADMIN_PW,
      "--email",
      ADMIN_EMAIL,
      "--must-change-password=false",
    ],
    { encoding: "utf8" },
  );
  const out = `${res.stdout}\n${res.stderr}`;
  if (res.status === 0) return;
  if (/user already exists/i.test(out)) return;
  throw new Error(
    `gitea admin user create failed (exit ${res.status}): ${out}`,
  );
}

interface PatRow {
  readonly id: number;
  readonly name: string;
}

async function basicAuthFetch(
  path: string,
  init: { method?: string; body?: string } = {},
): Promise<Response> {
  const auth = Buffer.from(`${ADMIN_USER}:${ADMIN_PW}`).toString("base64");
  return fetch(`${E2E_ENDPOINTS.giteaBaseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}

async function mintAdminPat(): Promise<string> {
  // Revoke a stale token of the same name first — the second
  // mint would otherwise 422.
  const list = await basicAuthFetch(
    `/api/v1/users/${ADMIN_USER}/tokens`,
  );
  if (!list.ok) {
    throw new Error(
      `gitea token list failed: HTTP ${list.status} ${await list.text()}`,
    );
  }
  const existing = (await list.json()) as PatRow[];
  const stale = existing.find((t) => t.name === PAT_NAME);
  if (stale !== undefined) {
    const del = await basicAuthFetch(
      `/api/v1/users/${ADMIN_USER}/tokens/${stale.id}`,
      { method: "DELETE" },
    );
    if (!del.ok) {
      throw new Error(
        `gitea token revoke failed: HTTP ${del.status} ${await del.text()}`,
      );
    }
  }
  const mint = await basicAuthFetch(
    `/api/v1/users/${ADMIN_USER}/tokens`,
    {
      method: "POST",
      body: JSON.stringify({
        name: PAT_NAME,
        scopes: ["write:repository", "write:user", "write:admin"],
      }),
    },
  );
  if (!mint.ok) {
    throw new Error(
      `gitea token mint failed: HTTP ${mint.status} ${await mint.text()}`,
    );
  }
  const body = (await mint.json()) as { sha1?: string };
  if (typeof body.sha1 !== "string" || body.sha1.length === 0) {
    throw new Error(`gitea token mint returned no sha1: ${JSON.stringify(body)}`);
  }
  return body.sha1;
}

/** Idempotent — calling twice in the same process returns the
 *  cached environment so the second test does not pay the cost
 *  of migrations + admin bootstrap a second time. */
export async function bootstrapEnvironment(): Promise<E2EEnvironment> {
  if (cachedEnv !== null) return cachedEnv;
  const pgPool = new pg.Pool({ connectionString: E2E_ENDPOINTS.postgresUrl });
  await applyMigrations(pgPool);
  ensureAdminUser();
  const giteaAdminPat = await mintAdminPat();
  cachedEnv = {
    pgPool,
    db: drizzle(pgPool),
    giteaBaseUrl: E2E_ENDPOINTS.giteaBaseUrl,
    giteaAdminUser: ADMIN_USER,
    giteaAdminPat,
  };
  return cachedEnv;
}

/** Tables truncated between tests. Includes every mutable
 *  application table — append-only audit tables are part of the
 *  list because each test asserts independently against a clean
 *  audit baseline. The order respects FK direction. */
const MUTABLE_TABLES = [
  "page_citations",
  "ingestion_intake",
  "webhook_events",
  "agent_runs",
  "redaction_events",
  "erasure_log",
  "admin_audit_log",
  "llm_usage",
  "llm_usage_debug",
  "credentials",
  "agent_instances",
  "sources_bindings",
  "users",
  "domains",
] as const;

async function truncatePostgres(pool: pg.Pool): Promise<void> {
  // Single statement, RESTART IDENTITY so any sequences reset.
  // CASCADE so a missed FK row doesn't fail the whole reset.
  await pool.query(
    `TRUNCATE TABLE ${MUTABLE_TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}

/** Recreate the named Gitea repo (delete + create with auto_init).
 *  Used per-test so each test sees an empty wiki repo. */
async function recreateRepo(
  env: E2EEnvironment,
  repoName: string,
): Promise<void> {
  const auth = `token ${env.giteaAdminPat}`;
  // Tolerate 404 — first run won't have the repo.
  await fetch(
    `${env.giteaBaseUrl}/api/v1/repos/${env.giteaAdminUser}/${repoName}`,
    { method: "DELETE", headers: { Authorization: auth } },
  );
  const create = await fetch(`${env.giteaBaseUrl}/api/v1/user/repos`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      name: repoName,
      private: false,
      auto_init: true,
      default_branch: "main",
    }),
  });
  if (!create.ok) {
    throw new Error(
      `gitea repo create failed for ${repoName}: HTTP ${create.status} ${await create.text()}`,
    );
  }
}

export interface ResetForTestArgs {
  /** Wiki repo names to recreate. Each becomes
   *  `<adminUser>/<repoName>` on the e2e Gitea. */
  readonly wikiRepos: readonly string[];
}

/** Per-test state reset. Truncates Postgres + recreates each
 *  named wiki repo so tests don't see each other's writes. */
export async function resetForTest(
  env: E2EEnvironment,
  args: ResetForTestArgs,
): Promise<void> {
  await truncatePostgres(env.pgPool);
  for (const repo of args.wikiRepos) {
    await recreateRepo(env, repo);
  }
}

/** Drain the cached pg.Pool. Called from suite teardown. */
export async function disposeEnvironment(): Promise<void> {
  if (cachedEnv === null) return;
  await cachedEnv.pgPool.end().catch(() => undefined);
  cachedEnv = null;
}

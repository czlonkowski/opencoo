/**
 * `opencoo doctor` (PR 30 / plan #135 decisions Q6, Q7, Q12).
 *
 * Diagnostics dump: every check the operator needs to triage a
 * "is this deployment healthy?" question. Layered checks:
 *
 *   1. Required env vars present (DATABASE_URL, ENCRYPTION_KEY,
 *      etc.). Uses `inspectSecret` so VALUES NEVER PRINT.
 *   2. Internet-facing surfaces enumerated (THREAT-MODEL §3.15):
 *      bound port, admin-API path, webhook receiver path. The
 *      operator confirms reverse-proxy posture against this
 *      list.
 *   3. Database reachable (`SELECT 1`).
 *   4. Schema migrations applied (count of rows in
 *      `drizzle.__drizzle_migrations`).
 *   5. (Optional) Gitea team-check: when `--admin-pat <pat>` or
 *      `OPENCOO_ADMIN_PAT` is set, calls Gitea's `/user/teams`
 *      and reports membership in `ADMIN_TEAM_SLUG`. Skipped
 *      with a warn when no PAT is provided.
 *
 * Exit code (decision Q6):
 *   - errors → exit 1
 *   - warnings only → exit 0 + stderr warn lines
 *
 * Output mode:
 *   - default: human-readable lines (picocolors)
 *   - --json: structured `DoctorReport` JSON for CI pipelines
 */
import pc from "picocolors";
import type { Pool } from "pg";

import {
  formatSecret,
  inspectSecret,
  type RedactedSecret,
} from "../lib/credential-redact.js";
import { exitOk, exitRuntimeError, exitUserError } from "../lib/exit.js";
import { openPool } from "../lib/db.js";

export type DoctorCheckLevel = "ok" | "warn" | "error";

export interface DoctorCheck {
  readonly id: string;
  readonly level: DoctorCheckLevel;
  readonly message: string;
  /** Optional structured detail — included in --json output. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface DoctorReport {
  readonly checks: ReadonlyArray<DoctorCheck>;
  readonly internetFacing: ReadonlyArray<string>;
  readonly secrets: ReadonlyArray<RedactedSecret>;
}

const REQUIRED_SECRETS = [
  "DATABASE_URL",
  "ENCRYPTION_KEY",
  "REDIS_URL",
  "GITEA_URL",
  "ADMIN_TEAM_SLUG",
  "SESSION_HMAC_KEY",
  "GITEA_BASE_URL",
] as const;

export interface DoctorArgs {
  readonly env: Record<string, string | undefined>;
  readonly json: boolean;
  /** Optional PAT for the team-check (decision Q12). When
   *  unset, the team-check skips with a warn. */
  readonly adminPat?: string;
  readonly stdout: { write: (s: string) => boolean };
  readonly stderr: { write: (s: string) => boolean };
  /** @internal Test seam — defaults to `openPool`. */
  readonly poolFactory?: (env: Record<string, string | undefined>) => Pool;
  /** @internal Test seam — substitute the Gitea team-check.
   *  Defaults to a real fetch-based call. */
  readonly giteaTeamsFn?: (args: {
    readonly baseUrl: string;
    readonly pat: string;
  }) => Promise<ReadonlyArray<string>>;
}

const INTERNET_FACING_PATHS: ReadonlyArray<string> = [
  "/health",
  "/ready",
  "/api/admin/_csrf",
  "/api/admin/source-bindings",
  "/api/admin/automation-candidates",
  "/api/admin/marketplace-updates",
  "/api/admin/audit-log",
  "/api/admin/domains",
  "/api/admin/prompts",
  "/api/admin/logout",
  "/api/admin/domains/:id/llm-policy/preview",
  "/api/admin/domains/:id/llm-policy/apply",
  "/webhooks/asana",
  "/webhooks/fireflies",
  "/webhooks/gitea",
];

async function checkDb(args: DoctorArgs): Promise<DoctorCheck> {
  let pool: Pool | null = null;
  try {
    const factory = args.poolFactory ?? ((e): Pool => openPool({ env: e }));
    pool = factory(args.env);
    const result = await pool.query<{ ok: number }>("SELECT 1 AS ok");
    if (result.rows[0]?.ok === 1) {
      return {
        id: "database",
        level: "ok",
        message: "database: SELECT 1 succeeded",
      };
    }
    return {
      id: "database",
      level: "error",
      message: "database: SELECT 1 returned no rows",
    };
  } catch (err) {
    return {
      id: "database",
      level: "error",
      message: `database: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (pool !== null) {
      await pool.end().catch(() => undefined);
    }
  }
}

async function checkMigrations(args: DoctorArgs): Promise<DoctorCheck> {
  let pool: Pool | null = null;
  try {
    const factory = args.poolFactory ?? ((e): Pool => openPool({ env: e }));
    pool = factory(args.env);
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    const count = Number.parseInt(result.rows[0]?.count ?? "0", 10);
    if (count === 0) {
      return {
        id: "migrations",
        level: "error",
        message:
          "migrations: drizzle.__drizzle_migrations is empty; run `opencoo migrate`",
        detail: { count },
      };
    }
    return {
      id: "migrations",
      level: "ok",
      message: `migrations: ${count} applied`,
      detail: { count },
    };
  } catch (err) {
    return {
      id: "migrations",
      level: "error",
      message: `migrations: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (pool !== null) {
      await pool.end().catch(() => undefined);
    }
  }
}

async function checkGiteaTeam(args: DoctorArgs): Promise<DoctorCheck> {
  const pat = args.adminPat ?? args.env["OPENCOO_ADMIN_PAT"];
  if (typeof pat !== "string" || pat.length === 0) {
    return {
      id: "gitea_team",
      level: "warn",
      message:
        "gitea_team: skipped (no --admin-pat or OPENCOO_ADMIN_PAT); cannot verify ADMIN_TEAM_SLUG membership",
    };
  }
  const teamSlug = args.env["ADMIN_TEAM_SLUG"];
  const baseUrl = args.env["GITEA_BASE_URL"];
  if (typeof teamSlug !== "string" || teamSlug.length === 0) {
    return {
      id: "gitea_team",
      level: "error",
      message: "gitea_team: ADMIN_TEAM_SLUG is unset; cannot check membership",
    };
  }
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    return {
      id: "gitea_team",
      level: "error",
      message: "gitea_team: GITEA_BASE_URL is unset; cannot reach Gitea",
    };
  }
  try {
    const teamsFn =
      args.giteaTeamsFn ??
      (async (a): Promise<ReadonlyArray<string>> => {
        // Minimal fetch — the real team-check uses the
        // production GiteaClient in engine-self-operating, but
        // the CLI keeps a focused fetch here so doctor doesn't
        // pull the whole engine package.
        const res = await fetch(`${a.baseUrl.replace(/\/+$/, "")}/api/v1/user/teams?limit=50`, {
          headers: { authorization: `token ${a.pat}`, accept: "application/json" },
        });
        if (!res.ok) {
          throw new Error(`gitea returned ${res.status}`);
        }
        const json = (await res.json()) as ReadonlyArray<{
          name?: unknown;
          organization?: { username?: unknown };
        }>;
        const out: string[] = [];
        for (const t of json) {
          const name = typeof t.name === "string" ? t.name : "";
          const org =
            typeof t.organization?.username === "string"
              ? t.organization.username
              : "";
          if (name.length === 0) continue;
          out.push(name);
          if (org.length > 0) out.push(`${org}/${name}`);
        }
        return out;
      });
    const teams = await teamsFn({ baseUrl, pat });
    if (!teams.includes(teamSlug)) {
      return {
        id: "gitea_team",
        level: "error",
        message: `gitea_team: PAT does not belong to '${teamSlug}'`,
        detail: { resolved_teams_count: teams.length },
      };
    }
    return {
      id: "gitea_team",
      level: "ok",
      message: `gitea_team: PAT is in '${teamSlug}'`,
    };
  } catch (err) {
    // Don't leak the PAT — the message is constructed from
    // controlled bytes only.
    return {
      id: "gitea_team",
      level: "error",
      message: `gitea_team: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function runDoctor(args: DoctorArgs): Promise<void> {
  const secrets = REQUIRED_SECRETS.map((name) => inspectSecret(args.env, name));
  const secretChecks: DoctorCheck[] = secrets.map((s) => ({
    id: `secret.${s.name}`,
    level: s.source === "unset" ? ("error" as const) : ("ok" as const),
    message: formatSecret(s),
  }));

  const dbCheck = await checkDb(args);
  const migCheck = dbCheck.level === "ok" ? await checkMigrations(args) : null;
  const giteaCheck = await checkGiteaTeam(args);

  const checks: DoctorCheck[] = [
    ...secretChecks,
    dbCheck,
    ...(migCheck !== null ? [migCheck] : []),
    giteaCheck,
  ];

  const report: DoctorReport = {
    checks,
    internetFacing: INTERNET_FACING_PATHS,
    secrets,
  };

  if (args.json) {
    args.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const c of checks) {
      const tag =
        c.level === "ok" ? pc.green("ok  ") : c.level === "warn" ? pc.yellow("warn") : pc.red("err ");
      const stream = c.level === "ok" ? args.stdout : args.stderr;
      stream.write(`${tag} ${c.message}\n`);
    }
    args.stdout.write("\n");
    args.stdout.write(pc.bold("internet-facing surfaces (operator should gate via reverse proxy):\n"));
    for (const p of INTERNET_FACING_PATHS) {
      args.stdout.write(`  ${p}\n`);
    }
  }

  // Exit code per Q6.
  const hasError = checks.some((c) => c.level === "error");
  if (hasError) {
    return exitUserError();
  }
  return exitOk();

  // exitRuntimeError reserved for future paths that exceed
  // user error scope — keep the import live so the symbol is
  // available without re-importing in a future hotfix.
  void exitRuntimeError;
}

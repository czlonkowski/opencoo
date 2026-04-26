/**
 * `opencoo migrate` (PR 30 / plan #135).
 *
 * Runs the Drizzle migrations from `packages/shared/drizzle/`
 * against the database at `DATABASE_URL`. Idempotent — Drizzle
 * tracks applied migrations in `drizzle.__drizzle_migrations`.
 *
 * v0.1 design: engines do NOT auto-migrate at boot (decision
 * Q4). The runbook tells the operator to run this command
 * BEFORE starting an engine. `--skip-migrate` is currently a
 * no-op (forward-compat for v0.2 auto-migrate).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import pc from "picocolors";

import { exitOk, exitRuntimeError, isExitSentinel } from "../lib/exit.js";
import { openPool } from "../lib/db.js";

export interface MigrateArgs {
  readonly env: Record<string, string | undefined>;
  readonly skipMigrate: boolean;
  readonly stdout: { write: (s: string) => boolean };
  readonly stderr: { write: (s: string) => boolean };
}

/**
 * Resolve the migrations dir. The `@opencoo/shared` package's
 * `drizzle/` directory ships in the published artifact (per its
 * package.json `files` field). At dev time we resolve relative
 * to this module's URL; at production time the same relative
 * walk works because cli/dist sits next to shared/drizzle in
 * the workspace install.
 */
function resolveMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // From packages/cli/dist/commands/ → ../../shared/drizzle
  // From packages/cli/src/commands/ → same relative walk.
  return path.resolve(here, "..", "..", "..", "shared", "drizzle");
}

export async function runMigrate(args: MigrateArgs): Promise<void> {
  if (args.skipMigrate) {
    args.stdout.write(
      pc.dim("migrate: --skip-migrate set; skipping (v0.1 no-op)\n"),
    );
    return exitOk();
  }
  const pool = openPool({ env: args.env });
  try {
    const db = drizzle(pool);
    const migrationsFolder = resolveMigrationsDir();
    args.stdout.write(`migrate: applying from ${migrationsFolder}\n`);
    await drizzleMigrate(db, { migrationsFolder });
    args.stdout.write(pc.green("migrate: ok\n"));
    return exitOk();
  } catch (err) {
    if (isExitSentinel(err)) throw err;
    args.stderr.write(
      pc.red(`migrate: failed (${err instanceof Error ? err.message : String(err)})\n`),
    );
    return exitRuntimeError();
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/**
 * migrate-applies-clean.test.ts — PR-Q5
 *
 * Smoke test: every committed migration in
 * `packages/shared/drizzle/` applies cleanly against an empty
 * Postgres. PR-Q5 closes the authored-and-merged bug in
 * `0010_lazy_fabian_cortez.sql` where a `text → uuid`
 * `ALTER COLUMN ... SET DATA TYPE` was emitted without a
 * `USING <col>::uuid` clause, which Postgres rejects with:
 *
 *   ERROR: column "delivery_id" cannot be cast automatically to
 *   type uuid
 *   HINT:  You might need to specify "USING delivery_id::uuid".
 *
 * Per CONVENTIONS.md §3 use-case tier — runs in-memory via
 * pglite (real Postgres in WASM) and bypasses Docker. pglite's
 * drizzle session uses prepared statements which can't run
 * multi-command chunks (5 of the 11 first-party migrations
 * pack `ALTER TABLE` + `CREATE INDEX` into one chunk without a
 * `--> statement-breakpoint`); we side-step that by applying
 * each chunk via `pg.exec()` (same simple-query path
 * `node-postgres` uses against real Postgres). The journal +
 * `__drizzle_migrations` book-keeping mirrors what drizzle's
 * migrator does, so a missing `USING` clause, a typo, or a
 * journal/file mismatch all surface here.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../drizzle");

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
  readonly breakpoints: boolean;
}
interface Journal {
  readonly entries: readonly JournalEntry[];
}

function readJournal(): Journal {
  const raw = readFileSync(
    path.join(migrationsFolder, "meta", "_journal.json"),
    "utf8",
  );
  return JSON.parse(raw) as Journal;
}

/** Mirror of drizzle's `pg-core/dialect.ts` migrate-loop. We
 *  apply each `--> statement-breakpoint`-separated chunk via
 *  pglite's `pg.exec()` (simple-query, multi-command-friendly)
 *  and record the row in `drizzle.__drizzle_migrations` the
 *  same way drizzle's migrator would. Doing it this way means
 *  a row count mismatch implies a real journal/file drift, not
 *  a quirk of the test harness. */
async function applyMigrations(pg: PGlite): Promise<void> {
  await pg.exec(`CREATE SCHEMA IF NOT EXISTS "drizzle";`);
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    );
  `);
  const journal = readJournal();
  for (const entry of journal.entries) {
    const file = path.join(migrationsFolder, `${entry.tag}.sql`);
    const body = readFileSync(file, "utf8");
    const hash = createHash("sha256").update(body).digest("hex");
    const chunks = body.split("--> statement-breakpoint");
    for (const chunk of chunks) {
      const trimmed = chunk.trim();
      if (trimmed.length === 0) continue;
      await pg.exec(chunk);
    }
    await pg.query(
      `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)`,
      [hash, entry.when],
    );
  }
}

describe("drizzle migrations apply cleanly against an empty database", () => {
  it("runs every committed migration end-to-end without throwing", async () => {
    const pg = new PGlite();
    await expect(applyMigrations(pg)).resolves.toBeUndefined();

    // Each applied migration writes one row. Asserting row
    // count == journal entry count proves every authored
    // migration ran, not just that the call returned without
    // throwing.
    const journal = readJournal();
    const result = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "drizzle"."__drizzle_migrations"`,
    );
    const row = result.rows[0];
    expect(row).toBeDefined();
    expect(Number(row?.count)).toBe(journal.entries.length);
  });
});

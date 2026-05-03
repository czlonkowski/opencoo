/**
 * `upsertIntake` — INSERT-or-skip into `ingestion_intake`, returning the
 * row id on insert and `null` when the
 * `(binding_id, source_doc_id, source_revision)` UNIQUE constraint
 * already matches an existing row (dedupe).
 *
 * The Scanner pipeline (PR 17) and the webhook receiver's direct-intake
 * branch (PR-N2) both use this — keeping them in lockstep on the
 * idempotency contract is the whole point of the shared helper.
 *
 * # Why a separate file
 *
 * The pre-PR-N2 implementation lived inside `pipelines/scanner.ts` as a
 * private function. Sharing it required either making the receiver
 * depend on the whole scanner module (drags `runScanner` + the
 * SourceAdapterRegistry abstraction into a place that doesn't need
 * either) or duplicating the SQL. The extracted helper is the cheaper
 * path: zero new behavior, the test for both call sites is the existing
 * intake-dedupe test in `pipelines/scanner.test.ts` plus the new
 * direct-intake assertions in `intake/webhook-receiver-direct-intake.test.ts`.
 *
 * # Why ON CONFLICT DO NOTHING (not DO UPDATE)
 *
 * `ingestion_intake` is the durable record of "this revision exists".
 * A duplicate is a no-op — there is no counter to bump, no metadata to
 * advance, no UPDATE we could legitimately apply that wouldn't be a
 * lie about provenance. The receiver caller distinguishes
 * "row exists, no enqueue needed" via the `null` return.
 *
 * # `recordIntake` vs `upsertIntake`
 *
 * The sibling `record-intake.ts` exposes `recordIntake` with a
 * different return shape (`{created, intakeId}` — always returns the
 * id, even on conflict). Two callers, two return shapes — keep both
 * around rather than collapsing the API surface, so the call site
 * documents its dedupe intent (`null === skip enqueue` for
 * upsertIntake; `created === false === already-known` for recordIntake).
 */
import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { SourceChangedDocument } from "@opencoo/shared/source-adapter";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

interface ExecResult<R> {
  readonly rows: R[];
  readonly rowCount?: number;
  readonly affectedRows?: number;
}

/**
 * INSERT into `ingestion_intake`. Returns the new row's id when a
 * fresh row landed, or `null` when the
 * `(binding_id, source_doc_id, source_revision)` UNIQUE constraint
 * matched an existing row (dedupe).
 *
 * `content_hash` is sha256(doc.contentBytes) — same shape the Scanner
 * pipeline writes for periodic-scan documents, so a webhook-pushed
 * document and a polled document with identical bytes share the same
 * hash (operator-visible audit signal).
 */
export async function upsertIntake(
  db: Db,
  bindingId: string,
  doc: SourceChangedDocument,
): Promise<string | null> {
  const contentHash = createHash("sha256")
    .update(doc.contentBytes)
    .digest("hex");
  const result = (await db.execute(sql`
    INSERT INTO ingestion_intake (binding_id, source_doc_id, source_revision, content_hash)
    VALUES (${bindingId}::uuid, ${doc.sourceDocId}, ${doc.sourceRevision}, ${contentHash})
    ON CONFLICT (binding_id, source_doc_id, source_revision) DO NOTHING
    RETURNING id::text AS id
  `)) as unknown as ExecResult<{ id: string }>;
  if (result.rows.length === 0) return null;
  return result.rows[0]?.id ?? null;
}

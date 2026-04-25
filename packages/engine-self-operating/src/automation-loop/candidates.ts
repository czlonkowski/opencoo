/**
 * Automation-candidate helpers — Gate 1 (insertion) + Gate 2
 * (build-time check) (plan #102 / THREAT-MODEL §7.2.4).
 *
 * # Gate 1 — `insertCandidate`
 *
 * The Surfacer agent emits proposals; the engine writes them
 * to `automation_candidates` via this helper. The helper
 * HARDCODES `status='proposed'` — there is NO `status`
 * argument the caller can override. A future PR that wants to
 * insert at any other status must edit this file (visible diff)
 * rather than smuggle it through a kwarg.
 *
 * The Review Dashboard UI is the only path that flips the row
 * from `proposed` → `approved` / `rejected` / `skipped`. The
 * Builder agent is the only path that flips `approved` → `built`.
 *
 * # Gate 2 — `requireApproved`
 *
 * The Builder agent's run-time entry guard. Loads the candidate
 * by id, asserts `status === 'approved'`, throws
 * `BuilderGate2Error(validation)` otherwise. Returns the loaded
 * row so the body can use `proposal` + `source_page_refs`
 * without re-querying.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { PageRef, Proposal } from "@opencoo/shared/db";

import { BuilderGate2Error } from "./errors.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

interface ExecResult<R> {
  readonly rows: R[];
}

interface CandidateRow {
  id: string;
  surfacer_run_id: string;
  source_page_refs: PageRef[];
  proposal: Proposal;
  status: string;
  rationale: string | null;
}

export interface AutomationCandidate {
  readonly id: string;
  readonly surfacerRunId: string;
  readonly sourcePageRefs: readonly PageRef[];
  readonly proposal: Proposal;
  readonly status:
    | "proposed"
    | "approved"
    | "rejected"
    | "built"
    | "skipped";
  readonly rationale: string | null;
}

function toCandidate(row: CandidateRow): AutomationCandidate {
  return {
    id: row.id,
    surfacerRunId: row.surfacer_run_id,
    sourcePageRefs: [...(row.source_page_refs ?? [])],
    proposal: row.proposal,
    status: row.status as AutomationCandidate["status"],
    rationale: row.rationale,
  };
}

export interface InsertCandidateArgs {
  readonly db: Db;
  readonly surfacerRunId: string;
  readonly sourcePageRefs: readonly PageRef[];
  readonly proposal: Proposal;
  readonly rationale?: string;
}

/**
 * Gate 1 — insert one automation_candidate row at
 * `status='proposed'`. The status is hardcoded here; callers
 * cannot override. This is the Surfacer agent's only sanctioned
 * path to `automation_candidates`.
 */
export async function insertCandidate(
  args: InsertCandidateArgs,
): Promise<{ readonly candidateId: string }> {
  const result = (await args.db.execute(sql`
    INSERT INTO automation_candidates
      (surfacer_run_id, source_page_refs, proposal, status, rationale)
    VALUES (
      ${args.surfacerRunId}::uuid,
      ${JSON.stringify(args.sourcePageRefs)}::jsonb,
      ${JSON.stringify(args.proposal)}::jsonb,
      'proposed',
      ${args.rationale ?? null}
    )
    RETURNING id::text AS id
  `)) as unknown as ExecResult<{ id: string }>;
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      "automation-loop.insertCandidate: INSERT returned no rows",
    );
  }
  return { candidateId: row.id };
}

/**
 * Gate 2 — load the candidate, assert `status === 'approved'`,
 * return the loaded row. Throws `BuilderGate2Error(validation)`
 * if not approved or not found.
 */
export async function requireApproved(
  db: Db,
  candidateId: string,
): Promise<AutomationCandidate> {
  const result = (await db.execute(sql`
    SELECT id::text AS id,
           surfacer_run_id::text AS surfacer_run_id,
           source_page_refs,
           proposal,
           status::text AS status,
           rationale
    FROM automation_candidates
    WHERE id = ${candidateId}::uuid
  `)) as unknown as ExecResult<CandidateRow>;
  const row = result.rows[0];
  if (row === undefined) {
    throw new BuilderGate2Error(candidateId, "<not-found>");
  }
  if (row.status !== "approved") {
    throw new BuilderGate2Error(candidateId, row.status);
  }
  return toCandidate(row);
}

/**
 * Builder helper — flip the candidate row from `approved` to
 * `built` after a successful deploy. Mutation-adjacent per
 * the schema docstring; this helper is the ONLY sanctioned
 * write path post-build (analogous to insertCandidate at
 * Gate 1).
 *
 * The status transition is `approved → built`; any other
 * starting state is a logic bug and the helper rejects it
 * with `BuilderGate2Error` (the row should have already
 * passed Gate 2 at the start of the run, but we re-check
 * defensively because a parallel UPDATE could have flipped
 * the row mid-run — fail-closed is safer than racing).
 */
export async function markBuilt(
  db: Db,
  candidateId: string,
): Promise<void> {
  const result = (await db.execute(sql`
    UPDATE automation_candidates
    SET status = 'built',
        updated_at = NOW()
    WHERE id = ${candidateId}::uuid
      AND status = 'approved'
    RETURNING id::text AS id
  `)) as unknown as ExecResult<{ id: string }>;
  if (result.rows[0] === undefined) {
    throw new BuilderGate2Error(
      candidateId,
      "<not-approved-at-flip-time>",
    );
  }
}

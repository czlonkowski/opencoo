/**
 * Pipelines tab — per-queue stats (phase-a appendix #4 PR-B).
 *
 * `GET /api/admin/pipelines`
 *   Returns a list of known pipeline queue stats. Each entry covers:
 *     - `name` — BullMQ queue name (e.g. `ingestion.scanner`).
 *     - `depth` — jobs in `waiting` state (queue backlog).
 *     - `failedCount` — jobs in `failed` state.
 *     - `dlqCount` — alias for failedCount in this v0.1 shape (DLQ is
 *       modelled as failed jobs; per-binding DLQ queues are v0.2).
 *     - `lastRunAt` — ISO timestamp of the most-recently completed job
 *       (read from `agent_runs`).
 *     - `lastFailureAt` — ISO timestamp of the most-recently failed run.
 *
 * Read-only; no state-changing actions. THREAT-MODEL §2 invariant 8.
 *
 * Non-fatal probe: if the BullMQ queue probe throws (Redis blip), the
 * pipeline entry still appears with `depth=0` and `failedCount=0` so the
 * UI doesn't flash a 500 error during a Redis restart.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface QueueRef {
  readonly name: string;
  readonly getJobCounts: (...states: string[]) => Promise<Record<string, number>>;
}

export interface RegisterPipelinesRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
  /** Queue instances to probe. When empty the route returns an empty array. */
  readonly queues: readonly QueueRef[];
}

interface PipelineStat {
  readonly name: string;
  readonly depth: number;
  readonly failedCount: number;
  readonly dlqCount: number;
  readonly lastRunAt: string | null;
  readonly lastFailureAt: string | null;
}

export function registerPipelinesRoutes(
  args: RegisterPipelinesRoutesArgs,
): void {
  args.app.get("/api/admin/pipelines", async () => {
    const pipelines: PipelineStat[] = await Promise.all(
      args.queues.map((q) => probeQueue(q, args.db)),
    );
    return { pipelines };
  });
}

async function probeQueue(queue: QueueRef, db: Db): Promise<PipelineStat> {
  // Probe BullMQ queue for depth + failed count. Non-fatal on error.
  let depth = 0;
  let failedCount = 0;
  try {
    const counts = await queue.getJobCounts("waiting", "failed");
    depth = counts["waiting"] ?? 0;
    failedCount = counts["failed"] ?? 0;
  } catch {
    // Redis blip — return zeroed stats rather than propagating.
  }

  // Pull last run + failure timestamps from agent_runs. The queue name
  // follows the `<prefix>.<slug>` convention; extract the slug as the
  // `pipeline_or_agent` match. For the ingestion.scanner queue the
  // llm_usage rows carry `pipeline_or_agent = 'ingestion.scanner'` but
  // agent_runs use `definition_slug = 'scanner'`. We query
  // agent_runs.definition_slug = slug part after last dot.
  const slug = queue.name.includes(".")
    ? queue.name.split(".").pop()!
    : queue.name;

  let lastRunAt: string | null = null;
  let lastFailureAt: string | null = null;
  try {
    const [lastRunResult, lastFailResult] = await Promise.all([
      lastStartedAt(db, slug, "success"),
      lastStartedAt(db, slug, "failed"),
    ]);
    lastRunAt = toIso(lastRunResult);
    lastFailureAt = toIso(lastFailResult);
  } catch {
    // DB query failure should not surface as a 500 — return nulls.
  }

  return {
    name: queue.name,
    depth,
    failedCount,
    dlqCount: failedCount, // v0.1: DLQ = failed jobs in the queue
    lastRunAt,
    lastFailureAt,
  };
}

/** Most-recent `started_at` for a definition_slug + status, or null. */
async function lastStartedAt(
  db: Db,
  slug: string,
  status: "success" | "failed",
): Promise<Date | string | null | undefined> {
  // `status` is a closed literal union (not user input); inlined via sql.raw
  // to keep the original literal SQL shape — bound params would force an
  // explicit ::agent_run_status cast.
  const result = (await db.execute(sql`
    SELECT started_at
    FROM agent_runs
    WHERE definition_slug = ${slug}
      AND status = ${sql.raw(`'${status}'`)}
    ORDER BY started_at DESC
    LIMIT 1
  `)) as unknown as { rows: Array<{ started_at: Date | string | null }> };
  return result.rows[0]?.started_at;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Instance memory loaders. Per the planner's reality check 5
 * the InstanceMemory shape is
 *   { type: 'none' | 'log-tail' | 'run-history',
 *     count?: int,
 *     agent_filter?: string,
 *     format?: string }
 * — `type` chooses the loader; `count` caps the tail; the
 * other two are reserved for v0.2 expansion.
 *
 * v0.1 ships two loaders:
 *   - 'none' → empty array (no memory injected).
 *   - 'run-history' → last N rows from agent_runs filtered to
 *      the same instance_id (instance-scope per
 *      THREAT-MODEL §3.5: an agent only sees its own past
 *      runs by default).
 *
 * 'log-tail' is reserved for v0.2 (would query
 * agent_runs.tool_calls[].result for a different stream — not
 * needed before the Heartbeat agent ships).
 *
 * SECURITY: every memory entry the harness injects into a
 * prompt MUST go through `spotlight()` from
 * @opencoo/shared/spotlight before reaching the LlmRouter.
 * The harness does the wrap; this module just returns raw
 * rows.
 */

import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

interface ExecResult<R> {
  readonly rows: R[];
}

export interface InstanceMemory {
  readonly type: "none" | "log-tail" | "run-history";
  readonly count?: number;
  readonly agent_filter?: string;
  readonly format?: string;
}

export interface MemoryEntry {
  /** UUID of the source agent_runs row (so the prompt can
   *  cite "see run abc-123"). */
  readonly runId: string;
  /** Wall-clock time the source run started — used for
   *  ordering only, never for prompt injection (the prompt
   *  sees the entry's body, not the timestamp). */
  readonly startedAt: Date;
  /** The terminal status of the source run. */
  readonly status: "running" | "success" | "failed" | "timeout";
  /** Untrusted body. The harness MUST spotlight() this
   *  before injecting into a prompt. */
  readonly body: string;
}

interface RunHistoryRow {
  id: string;
  started_at: string;
  status: string;
  output: unknown;
}

const DEFAULT_COUNT = 5;

export async function loadInstanceMemory(
  db: Db,
  instanceId: string,
  memory: InstanceMemory,
): Promise<readonly MemoryEntry[]> {
  if (memory.type === "none") return [];
  if (memory.type === "log-tail") {
    // Reserved for v0.2 — the Heartbeat agent's "tail the
    // execution log" feature. v0.1 returns empty so the
    // harness path doesn't crash on configured-but-not-yet-
    // implemented memory types.
    return [];
  }
  // 'run-history' — last N successful+failed terminal rows
  // for THIS instance_id, newest first.
  const count = memory.count ?? DEFAULT_COUNT;
  if (count <= 0) return [];
  const result = (await db.execute(sql`
    SELECT id::text AS id,
           started_at::text AS started_at,
           status::text AS status,
           output
    FROM agent_runs
    WHERE instance_id = ${instanceId}::uuid
      AND status IN ('success', 'failed', 'timeout')
    ORDER BY started_at DESC
    LIMIT ${count}
  `)) as unknown as ExecResult<RunHistoryRow>;
  return result.rows.map((row) => ({
    runId: row.id,
    startedAt: new Date(row.started_at),
    status: row.status as MemoryEntry["status"],
    body: typeof row.output === "string" ? row.output : JSON.stringify(row.output ?? {}),
  }));
}

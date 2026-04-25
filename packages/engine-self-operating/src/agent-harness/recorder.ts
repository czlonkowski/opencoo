/**
 * Agent run recorder. Two operations:
 *
 *   - `startRun(args)` — INSERT one `agent_runs` row with
 *     `status: 'running'`. Returns the new run id; the harness
 *     stitches every tool call into `tool_calls[]` over the
 *     run's lifetime and passes them all to `completeRun`.
 *
 *   - `completeRun(args)` — single guarded UPDATE that
 *     terminalizes the row from `running` to `success`,
 *     `failed`, or `timeout`. Per THREAT-MODEL §2 invariant 8
 *     (amended in PR 19 / plan #87 Q11):
 *
 *       The harness builds the UPDATE with a
 *       `WHERE status = 'running'` guard so a terminal row
 *       can never be re-mutated; once status is terminal,
 *       the row is append-only.
 *
 *     The guard is enforced at TWO layers:
 *       1. The SQL itself includes the WHERE clause so any
 *          double-call hits 0 affected rows even on a buggy
 *          caller.
 *       2. The recorder inspects the affected-row count
 *          and throws `AgentRunAlreadyTerminalError` (a
 *          validation-class error → DLQ) when 0.
 */

import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { Logger } from "@opencoo/shared/logger";
import type { ToolCall } from "@opencoo/shared/db";

import { AgentRunAlreadyTerminalError } from "./errors.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

interface ExecResult<R> {
  readonly rows: R[];
  readonly rowCount?: number;
  readonly affectedRows?: number;
}

export type AgentTrigger = "scheduled" | "http" | "mcp";
export type TerminalStatus = "success" | "failed" | "timeout";
export type ErrorClass = "transient" | "upstream-quota" | "validation";

export interface StartRunArgs {
  readonly db: Db;
  readonly definitionSlug: string;
  readonly instanceId: string;
  readonly trigger: AgentTrigger;
  readonly inputs: Record<string, unknown>;
  readonly now?: () => Date;
}

export interface StartRunResult {
  readonly runId: string;
  readonly startedAt: Date;
}

export async function startRun(args: StartRunArgs): Promise<StartRunResult> {
  const startedAt = (args.now ?? ((): Date => new Date()))();
  const result = (await args.db.execute(sql`
    INSERT INTO agent_runs
      (definition_slug, instance_id, trigger, inputs, status, started_at, created_at)
    VALUES (
      ${args.definitionSlug},
      ${args.instanceId}::uuid,
      ${args.trigger},
      ${JSON.stringify(args.inputs)}::jsonb,
      'running',
      ${startedAt.toISOString()},
      ${startedAt.toISOString()}
    )
    RETURNING id::text AS id
  `)) as unknown as ExecResult<{ id: string }>;
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("agent-harness: startRun INSERT returned no rows");
  }
  return { runId: row.id, startedAt };
}

export interface CompleteRunArgs {
  readonly db: Db;
  readonly logger: Logger;
  readonly runId: string;
  readonly status: TerminalStatus;
  readonly output: unknown;
  readonly toolCalls: readonly ToolCall[];
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly errorClass?: ErrorClass;
  readonly endedAt?: Date;
}

/**
 * Terminalize the run. Throws `AgentRunAlreadyTerminalError`
 * if the row's status is no longer `running` (defense-in-depth
 * + observable error so the caller's BullMQ wrapper DLQs).
 */
export async function completeRun(args: CompleteRunArgs): Promise<void> {
  const endedAt = args.endedAt ?? new Date();
  const errorClassValue = args.errorClass ?? null;
  // SOLE sanctioned UPDATE on `agent_runs` — §2 invariant 8
  // carve-out. Two-layer safeguard:
  //   1. SQL `WHERE status = 'running'` clause — a terminal
  //      row hits 0 affected rows even on a buggy caller.
  //   2. JS rowCount check below + AgentRunAlreadyTerminalError
  //      → DLQ (validation-class).
  // Lint disable pins the carve-out at exactly this call
  // site: `agentRuns` is in `APPEND_ONLY_TABLES` and any
  // other UPDATE/DELETE path lints red. This is also a
  // forward-looking guard — if the raw-SQL form is ever
  // refactored to `args.db.update(agentRuns)`, the
  // `eslint-disable-next-line` keeps this single sanctioned
  // location passing while the rest of the codebase stays
  // protected.
  // eslint-disable-next-line opencoo/no-update-append-only
  const result = (await args.db.execute(sql`
    UPDATE agent_runs
    SET status = ${args.status},
        output = ${JSON.stringify(args.output)}::jsonb,
        tool_calls = ${JSON.stringify(args.toolCalls)}::jsonb,
        tokens_in = ${args.tokensIn},
        tokens_out = ${args.tokensOut},
        cost_usd = ${args.costUsd.toFixed(6)},
        latency_ms = ${args.latencyMs},
        ended_at = ${endedAt.toISOString()},
        error_class = ${errorClassValue}
    WHERE id = ${args.runId}::uuid AND status = 'running'
    RETURNING id::text AS id
  `)) as unknown as ExecResult<{ id: string }>;

  const updated =
    result.rowCount ?? result.affectedRows ?? result.rows.length;
  if (updated === 0) {
    args.logger.warn("agent_runs.complete_refused", {
      run_id: args.runId,
      reason: "row already terminal — WHERE status='running' guard rejected the UPDATE",
    });
    throw new AgentRunAlreadyTerminalError(args.runId);
  }
  args.logger.info("agent_runs.completed", {
    run_id: args.runId,
    status: args.status,
    tokens_in: args.tokensIn,
    tokens_out: args.tokensOut,
    cost_usd: args.costUsd,
    latency_ms: args.latencyMs,
    tool_call_count: args.toolCalls.length,
  });
}

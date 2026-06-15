/**
 * Agent harness orchestrator. Wires:
 *   - instance loader (which definition, which scope, what
 *     memory config)
 *   - memory loader (the prior runs the agent should see)
 *   - spotlight (every memory entry wrapped in
 *     <source_content> before the prompt sees it — defense
 *     against memory poisoning per THREAT-MODEL §3.5)
 *   - run recorder (one INSERT at start, one guarded UPDATE
 *     at completion)
 *   - LlmRouter (per-domain llm_policy enforcement,
 *     llm_usage telemetry)
 *
 * Concrete agents (Heartbeat, Lint, Builder, Chat, Surfacer)
 * arrive in PR 20+. v0.1 ships only the orchestrator + the
 * runtime contract so the schema-of-record stays in lockstep
 * with the in-memory definitions and the carve-out-guarded
 * UPDATE path is exercised end-to-end.
 *
 * Error routing: any exception from the agent body
 * terminalizes the run as `status: 'failed'` with the
 * caught error's class. AgentDenyListError + Zod-strict
 * rejects → validation. LlmBudgetExceededError /
 * LlmPolicyViolationError → upstream-quota. Anything else
 * → transient.
 */

import type {
  GenerateObjectOpts,
  GenerateObjectResult,
  GenerateOpts,
  GenerateTextResult,
  LlmRouter,
} from "@opencoo/shared/llm-router";
import type { Logger } from "@opencoo/shared/logger";
import type { ToolCall } from "@opencoo/shared/db";
import { spotlight } from "@opencoo/shared/spotlight";
import { sql } from "drizzle-orm";

import { assertToolAllowed } from "./deny-list.js";
import { loadInstanceById, type AgentInstance } from "./instances.js";
import {
  loadInstanceMemory,
  type InstanceMemory,
} from "./memory.js";
import {
  completeRun,
  startRun,
  type AgentTrigger,
  type ErrorClass,
  type TerminalStatus,
} from "./recorder.js";
import type { AgentDefinition, AgentDefinitionRegistry } from "./definitions.js";
import { OpencooError } from "@opencoo/shared/errors";
import type { SseBus } from "../admin-api/sse-bus.js";

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface AgentInvocation {
  readonly definitions: AgentDefinitionRegistry;
  readonly db: Db;
  readonly router: LlmRouter;
  readonly logger: Logger;
  readonly instanceId: string;
  readonly trigger: AgentTrigger;
  readonly inputs: Record<string, unknown>;
  /** Caller's gitea PAT, if this invocation came from an
   *  authenticated user (Chat agent path). Propagated
   *  verbatim into AgentRunContext.callerPat — agents that
   *  need PAT-scoped MCP tooling consume it via
   *  `createPatScopedMcpClient(base, ctx.callerPat!)`.
   *  Reader agents on the scheduled cadence (Heartbeat,
   *  Lint) leave this undefined; the Chat agent body throws
   *  ChatPatRequiredError on undefined-or-empty (Q2). The
   *  harness does NOT validate — whatever the caller passes
   *  reaches the body unchanged so each agent can apply its
   *  own contract. */
  readonly callerPat?: string;
  /** The agent's body — receives the loaded instance + the
   *  spotlighted memory string + the LlmRouter and returns
   *  the JSON output to persist. v0.1 routes against the
   *  domains exposed via `instance.scopeDomainIds`; an
   *  explicit per-invocation domain override arrives in
   *  PR 20+ when a concrete agent demonstrates the need. */
  readonly run: (ctx: AgentRunContext) => Promise<unknown>;
  readonly clock?: () => Date;
  /** Optional SSE bus. When present, the harness emits `agent_run`
   *  lifecycle events on run start, success, and failure so the
   *  Activity feed shows runs as they unfold.
   *
   *  Token-level streaming from the LLM router is a larger refactor
   *  (requires the router to call `emitToken` per-chunk). That wire-up
   *  is deferred to PR-B.1. TODO(PR-B.1): wire llm-router streaming
   *  → sseBus.emitToken once the router exposes a per-token hook. */
  readonly sseBus?: SseBus;
}

/** The slice of the LLM router agent bodies use. The harness wraps
 *  the real router so every call is attributed to the active run
 *  (engine:'self-op' + run_id), letting llm_usage be aggregated per
 *  agent run. Agents use `generateObject` today; `generateText` is
 *  exposed for completeness. */
export type AgentRouter = Pick<LlmRouter, "generateObject" | "generateText">;

export interface AgentRunContext {
  readonly definition: AgentDefinition;
  readonly instance: AgentInstance;
  /** UUID of the active agent_runs row. Agents that persist
   *  side rows keyed by run id (e.g. Surfacer →
   *  automation_candidates.surfacer_run_id, Builder →
   *  automation_deployments.builder_run_id) read this. The
   *  recorder INSERTed the row before this body executes; the
   *  harness wires the same id into completeRun on
   *  terminalization. (PR 21 / plan #102) */
  readonly runId: string;
  /** Memory entries already spotlighted (each entry's body
   *  is wrapped in a <source_content> envelope). The agent
   *  body concatenates them into its prompt without
   *  re-wrapping. */
  readonly spotlightedMemory: readonly string[];
  readonly router: LlmRouter;
  readonly logger: Logger;
  /** Caller's gitea PAT verbatim from AgentInvocation.callerPat.
   *  See AgentInvocation.callerPat for the full propagation
   *  contract; the harness does no validation. */
  readonly callerPat?: string;
  /** Tool-dispatch helper that runs the deny-list check
   *  before invoking the caller's tool. Every tool call the
   *  agent makes flows through this. */
  callTool<R>(name: string, fn: () => Promise<R>): Promise<R>;
  /** Mutate the in-progress tool-call ledger so the recorder
   *  has the full trace at terminalization. */
  recordToolCall(call: ToolCall): void;
}

export interface AgentInvocationResult {
  readonly runId: string;
  readonly status: TerminalStatus;
  readonly output: unknown;
}

function classifyError(err: unknown): ErrorClass {
  if (err instanceof OpencooError) {
    if (err.errorClass === "validation") return "validation";
    if (err.errorClass === "upstream-quota") return "upstream-quota";
    return "transient";
  }
  return "transient";
}

export async function invokeAgent(
  args: AgentInvocation,
): Promise<AgentInvocationResult> {
  const clock = args.clock ?? ((): Date => new Date());

  const instance = await loadInstanceById(args.db, args.instanceId);
  const definition = args.definitions.get(instance.definitionSlug);
  if (definition === undefined) {
    // Caller registered an instance whose slug doesn't match
    // any in-memory definition — config bug, fail fast.
    throw new Error(
      `agent-harness: instance ${instance.id} references unknown agent definition '${instance.definitionSlug}'`,
    );
  }

  // The `agent_instances.memory` JSONB column is typed as
  // InstanceMemory in the schema, but the harness's loose
  // instance shape returns it as Record<string, unknown>.
  // Narrow via `unknown` first under exactOptionalPropertyTypes;
  // a misshapen row would surface as a runtime error one level
  // deeper inside loadInstanceMemory.
  const memoryConfig = instance.memory as unknown as InstanceMemory;
  const memoryEntries = await loadInstanceMemory(
    args.db,
    instance.id,
    memoryConfig,
  );
  const spotlightedMemory = memoryEntries.map((entry) =>
    spotlight({
      content: entry.body,
      source: `agent_run:${entry.runId}`,
      fetchedAt: entry.startedAt,
    }),
  );

  const { runId, startedAt } = await startRun({
    db: args.db,
    definitionSlug: instance.definitionSlug,
    instanceId: instance.id,
    trigger: args.trigger,
    inputs: args.inputs,
    now: clock,
  });

  // Emit run-start event so the Activity feed shows the run as "running".
  args.sseBus?.emitRunEvent({
    runId,
    definitionSlug: instance.definitionSlug,
    status: "running",
    startedAt: startedAt.toISOString(),
  });

  const toolCalls: ToolCall[] = [];

  // Wrap the router so every LLM call the body makes is attributed to
  // this agent run (engine:'self-op' + run_id). Without this, self-op
  // agent spend was invisible — recorded as 'ingestion' with no run
  // linkage — and agent_runs.cost stayed hardcoded 0.
  const runScopedRouter: AgentRouter = {
    generateObject<T>(
      opts: GenerateObjectOpts<T>,
    ): Promise<GenerateObjectResult<T>> {
      return args.router.generateObject<T>({
        ...opts,
        engine: "self-op",
        runId,
      });
    },
    generateText(opts: GenerateOpts): Promise<GenerateTextResult> {
      return args.router.generateText({ ...opts, engine: "self-op", runId });
    },
  };

  const ctx: AgentRunContext = {
    definition,
    instance,
    runId,
    spotlightedMemory,
    // The wrapper implements only the generate* surface agents use;
    // cast to the full LlmRouter type the context exposes. (Agents and
    // their helpers never touch the router's other members.)
    router: runScopedRouter as unknown as LlmRouter,
    logger: args.logger,
    // Propagate verbatim. Only attach the key when the caller
    // supplied one — under exactOptionalPropertyTypes, an
    // explicit `callerPat: undefined` differs from an absent
    // key. Agents that read this field via `?? someDefault`
    // see the same semantics either way; this keeps the
    // shape clean.
    ...(args.callerPat !== undefined ? { callerPat: args.callerPat } : {}),
    async callTool<R>(name: string, fn: () => Promise<R>): Promise<R> {
      assertToolAllowed(name);
      const t0 = clock().getTime();
      try {
        const result = await fn();
        toolCalls.push({
          name,
          // toolCallSchema requires `args` (z.unknown()).
          // JSON.stringify drops undefined keys, so the JSONB
          // row would lack `args` entirely and re-parse on
          // read would fail. Default to `{}` here; agents that
          // call tools with structured arguments push entries
          // explicitly via `recordToolCall`.
          args: {},
          result: result as unknown,
          durationMs: clock().getTime() - t0,
        });
        return result;
      } catch (err) {
        toolCalls.push({
          name,
          args: {},
          durationMs: clock().getTime() - t0,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    recordToolCall(call: ToolCall): void {
      toolCalls.push(call);
    },
  };

  let output: unknown;
  let status: TerminalStatus;
  let errorClass: ErrorClass | undefined;
  try {
    output = await args.run(ctx);
    status = "success";
  } catch (err) {
    output = {
      error: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : "Unknown",
    };
    status = "failed";
    errorClass = classifyError(err);
    args.logger.warn("agent_runs.body_failed", {
      run_id: runId,
      definition_slug: definition.slug,
      instance_id: instance.id,
      error_class: errorClass,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const endedAt = clock();
  const latencyMs = endedAt.getTime() - startedAt.getTime();

  // Aggregate this run's LLM usage. The run-scoped router recorded
  // every call with `run_id = runId`, so summing llm_usage is the
  // authoritative per-run token/cost total (covers multi-call bodies
  // and structured-output repair retries). Resolves the prior
  // hardcoded-0 placeholder (was TODO PR-B.1).
  const usageAgg = (await args.db.execute(sql`
    SELECT
      COALESCE(SUM(tokens_in), 0)::int AS tokens_in,
      COALESCE(SUM(tokens_out), 0)::int AS tokens_out,
      COALESCE(SUM(cost_usd), 0)::numeric AS cost_usd
    FROM llm_usage
    WHERE run_id = ${runId}::uuid
  `)) as unknown as {
    rows: Array<{ tokens_in: number; tokens_out: number; cost_usd: string }>;
  };
  const usageRow = usageAgg.rows[0];
  const tokensIn = usageRow ? Number(usageRow.tokens_in) : 0;
  const tokensOut = usageRow ? Number(usageRow.tokens_out) : 0;
  const costUsd = usageRow ? Number(usageRow.cost_usd) : 0;

  await completeRun({
    db: args.db,
    logger: args.logger,
    runId,
    status,
    output,
    toolCalls,
    tokensIn,
    tokensOut,
    costUsd,
    latencyMs,
    ...(errorClass !== undefined ? { errorClass } : {}),
    endedAt,
  });

  // Emit run-completion event so the Activity feed reflects the terminal state.
  args.sseBus?.emitRunEvent({
    runId,
    definitionSlug: instance.definitionSlug,
    status,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    latencyMs,
    ...(errorClass !== undefined ? { errorClass } : {}),
  });

  return { runId, status, output };
}

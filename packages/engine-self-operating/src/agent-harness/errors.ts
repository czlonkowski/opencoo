/**
 * Agent harness error taxonomy. Mirrors the
 * @opencoo/shared/errors three-class shape so the BullMQ retry
 * machinery (PR 17) keys on errorClass uniformly with the
 * ingestion-side errors.
 *
 *   - validation     → DLQ, no retry (adversarial input,
 *                      forbidden tool, schema-strict reject).
 *   - upstream-quota → exponential backoff (LLM budget, rate
 *                      limit; LlmRouter throws its own
 *                      LlmPolicyViolationError / LlmBudgetExceededError
 *                      which already carry this class).
 *   - transient      → linear backoff (network blip; the run
 *                      recorder marks status='failed' but the
 *                      caller can retry).
 */

import { OpencooError, type OpencooErrorOptions } from "@opencoo/shared/errors";

/**
 * The agent's destructive-tool deny-list (THREAT-MODEL §3.8)
 * fired. Routed as `validation` so the run is DLQ'd, not
 * retried — a malicious tool name is a poison signal that
 * retry won't recover from.
 */
export class AgentDenyListError extends OpencooError {
  readonly toolName: string;

  constructor(
    toolName: string,
    options?: OpencooErrorOptions,
  ) {
    super(
      `agent-harness: tool '${toolName}' is on the destructive-tool deny-list`,
      "validation",
      options,
    );
    this.name = "AgentDenyListError";
    this.toolName = toolName;
  }
}

/**
 * The agent_instances row referenced by the harness call doesn't
 * exist (or is disabled). Caller bug — not retryable.
 */
export class AgentInstanceNotFoundError extends OpencooError {
  readonly instanceId: string;

  constructor(instanceId: string, options?: OpencooErrorOptions) {
    super(
      `agent-harness: instance ${instanceId} not found or disabled`,
      "validation",
      options,
    );
    this.name = "AgentInstanceNotFoundError";
    this.instanceId = instanceId;
  }
}

/**
 * The agent_runs row tried to terminalize but the runtime
 * `WHERE status = 'running'` guard returned 0 affected rows —
 * the row is already terminal. Caller bug (calling
 * completeRun twice). Routed as `validation` so the duplicate
 * call DLQs without re-mutating the terminal row.
 */
export class AgentRunAlreadyTerminalError extends OpencooError {
  readonly runId: string;

  constructor(runId: string, options?: OpencooErrorOptions) {
    super(
      `agent-harness: run ${runId} is already terminal — completeRun() refused (one-time-mutation guard)`,
      "validation",
      options,
    );
    this.name = "AgentRunAlreadyTerminalError";
    this.runId = runId;
  }
}

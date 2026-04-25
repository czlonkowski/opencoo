/**
 * Mock Asana task-create API for use-case tests (PR 24 /
 * plan #115). Backed by a programmable upstream-behavior
 * state object so the contract suite can exercise the 200,
 * 429, 5xx paths in turn.
 */
import type {
  AsanaApiError,
  AsanaCreateTaskArgs,
  AsanaCreateTaskResult,
  AsanaLikeApi,
} from "../asana-api.js";

export type UpstreamBehavior =
  | { readonly kind: "ok" }
  | {
      readonly kind: "http-error";
      readonly status: number;
      readonly retryAfterSeconds?: number;
    }
  | { readonly kind: "transient" };

export interface MockAsanaApiState {
  behavior: UpstreamBehavior;
  readonly calls: AsanaCreateTaskArgs[];
}

export function createMockAsanaApiState(): MockAsanaApiState {
  return {
    behavior: { kind: "ok" },
    calls: [],
  };
}

export function makeMockAsanaApi(state: MockAsanaApiState): AsanaLikeApi {
  let nextGid = 1;
  return {
    async createTask(
      args: AsanaCreateTaskArgs,
    ): Promise<AsanaCreateTaskResult> {
      // Capture BEFORE behavior dispatch so failure-path
      // assertions can still inspect what would have been
      // sent — but assertion 8 expects ZERO calls when the
      // schema rejects, so the adapter must never reach this
      // point on rejects.
      state.calls.push(args);
      const behavior = state.behavior;
      if (behavior.kind === "ok") {
        const gid = `asana-task-${nextGid++}`;
        return { gid, permalinkUrl: `https://app.asana.com/0/0/${gid}` };
      }
      if (behavior.kind === "http-error") {
        const err: AsanaApiError = {
          kind: "http",
          status: behavior.status,
          ...(behavior.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: behavior.retryAfterSeconds }
            : {}),
          message: `asana mock returned HTTP ${behavior.status}`,
        };
        throw err;
      }
      // transient
      const err: AsanaApiError = {
        kind: "transient",
        message: "asana mock simulated network drop",
      };
      throw err;
    },
  };
}

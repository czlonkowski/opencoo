/**
 * Mock n8n REST API for use-case tests (PR 25 / plan #120).
 * Backed by a programmable upstream-behavior state object so the
 * test harness can drive the 200, 401, 429, 5xx paths in turn.
 *
 * Captures `bearerToken` so the rotation-pin test can assert the
 * adapter resolves credentials from the CredentialStore on
 * every deployWorkflow call (not memoized).
 */
import type {
  N8nApiError,
  N8nCreateWorkflowArgs,
  N8nCreateWorkflowResult,
  N8nLikeApi,
  N8nWorkflowBody,
} from "../n8n-api.js";

export type N8nUpstreamBehavior =
  | { readonly kind: "ok" }
  | {
      readonly kind: "http-error";
      readonly status: number;
      readonly retryAfterSeconds?: number;
    }
  | { readonly kind: "transient" };

export interface CapturedN8nCall {
  readonly bearerToken: string;
  readonly baseUrl: string;
  readonly apiVersion: "v1";
  readonly body: N8nWorkflowBody;
}

export interface MockN8nApiState {
  behavior: N8nUpstreamBehavior;
  readonly calls: CapturedN8nCall[];
}

export function createMockN8nApiState(): MockN8nApiState {
  return {
    behavior: { kind: "ok" },
    calls: [],
  };
}

export function makeMockN8nApi(state: MockN8nApiState): N8nLikeApi {
  let nextId = 1;
  return {
    async createWorkflow(
      args: N8nCreateWorkflowArgs,
    ): Promise<N8nCreateWorkflowResult> {
      state.calls.push({
        bearerToken: args.bearerToken,
        baseUrl: args.baseUrl,
        apiVersion: args.apiVersion,
        body: args.body,
      });
      const behavior = state.behavior;
      if (behavior.kind === "ok") {
        return { id: `wf-mock-${nextId++}` };
      }
      if (behavior.kind === "http-error") {
        const err: N8nApiError = {
          kind: "http",
          status: behavior.status,
          ...(behavior.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: behavior.retryAfterSeconds }
            : {}),
          message: `n8n mock returned HTTP ${behavior.status}`,
        };
        throw err;
      }
      const err: N8nApiError = {
        kind: "transient",
        message: "n8n mock simulated network drop",
      };
      throw err;
    },
  };
}

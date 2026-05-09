/**
 * Shared `agent_run` SSE subscription helper for the
 * AgentsRunNowButton (PR-R3, phase-a appendix #10).
 *
 * The button observes the `agent_run` lifecycle stream on the
 * admin SSE endpoint to flip its `queued -> running -> done`
 * state. Activity / Reports / LintFindings each host one or more
 * buttons and need a stable subscription factory shared across
 * the cards on the page.
 *
 * The default factory opens ONE `openSseClient("/api/admin/events")`
 * per listener (the per-route `useMemo` ensures one factory per
 * mount, and each listener subscribes once); the returned `off`
 * closes the client. Tests inject a stub directly into the route's
 * `subscribeToAgentRuns` prop, bypassing this helper entirely.
 */
import { openSseClient } from "./sse.js";

/** The slim payload the button consumes — a subset of the full
 *  `agent_run` SSE frame (which also carries `startedAt`). */
export interface AgentRunEvent {
  readonly runId: string;
  readonly definitionSlug: string;
  readonly status: string;
}

/** Factory shape: hand it a listener, get back an `off` callable. */
export type SubscribeToAgentRuns = (
  listener: (evt: AgentRunEvent) => void,
) => () => void;

/** Default production factory — opens an SSE client against the
 *  admin events endpoint and forwards every `agent_run` frame to
 *  the supplied listener, projecting the wire payload down to
 *  `AgentRunEvent`. The returned `off` closes the client. */
export function defaultSubscribeToAgentRuns(): SubscribeToAgentRuns {
  return (listener) => {
    const client = openSseClient("/api/admin/events");
    const off = client.on<{
      runId: string;
      definitionSlug: string;
      status: string;
      startedAt: string;
    }>("agent_run", (evt) => {
      listener({
        runId: evt.data.runId,
        definitionSlug: evt.data.definitionSlug,
        status: evt.data.status,
      });
    });
    return (): void => {
      off();
      client.close();
    };
  };
}

/**
 * Shared `agent_run` SSE subscription helper for the
 * AgentsRunNowButton (PR-R3, phase-a appendix #10).
 *
 * The button observes the `agent_run` lifecycle stream on the
 * admin SSE endpoint to flip its `queued -> running -> done`
 * state. Activity / Reports / LintFindings each host one or more
 * buttons; all buttons on a page MUST share ONE underlying SSE
 * connection — N buttons must NOT each open their own pipe to
 * the engine.
 *
 * The architecture is:
 *
 *   - `createAgentRunsSubscription(...)` returns a stable
 *     `AgentRunSubscription` object exposing `subscribe(handler)`
 *     (per-listener fan-out) and `close()` (unmount-time
 *     tear-down). The underlying SSE client is opened LAZILY on
 *     the first `subscribe` call so a parent that mounts but
 *     never renders a button (e.g. a page with no dispatchable
 *     domains) doesn't open an SSE pipe at all — and tests that
 *     don't reach a button don't pay for a `globalThis.fetch`
 *     call against the admin endpoint.
 *   - The page-mount component memoises the subscription via
 *     `useMemo` so it survives re-renders, registers a single
 *     unmount cleanup that calls `close()`, and passes
 *     `subscription.subscribe` (NOT the whole object) down to
 *     each button.
 *   - Each button's `useEffect` calls `subscribe(handler)` and
 *     uses the returned `off` callback to detach without closing
 *     the shared SSE pipe.
 *
 * Tests can either inject a stub subscription via the route's
 * `subscribeToAgentRuns` prop or use `createAgentRunsSubscription`
 * with a fake `fetchImpl`.
 *
 * History note: a prior shape returned a `SubscribeToAgentRuns`
 * factory whose `subscribe` callback opened a fresh SSE client
 * per call — N buttons opened N concurrent SSE pipes against the
 * same endpoint. This file enforces a single-client invariant
 * via the `AgentRunSubscription` interface below.
 */
import { openSseClient, type SseClient } from "./sse.js";

/** The slim payload the button consumes — a subset of the full
 *  `agent_run` SSE frame (which also carries `startedAt`). */
export interface AgentRunEvent {
  readonly runId: string;
  readonly definitionSlug: string;
  readonly status: string;
}

/** Per-listener subscribe callable. The button accepts THIS
 *  shape (not the whole `AgentRunSubscription` object) so it
 *  cannot accidentally call `close()` on the shared client.
 *
 *  CRITICAL: callers MUST share ONE subscription object across
 *  multiple buttons (e.g., via `createAgentRunsSubscription`
 *  inside a parent `useMemo`) and pass `subscription.subscribe`
 *  down. Constructing a fresh `AgentRunSubscription` per button
 *  mount would defeat the single-pipe invariant. */
export type SubscribeToAgentRuns = (
  listener: (evt: AgentRunEvent) => void,
) => () => void;

/** A shared SSE-backed subscription. ONE underlying SSE client
 *  fans out to N listeners. Constructed once per page mount via
 *  `createAgentRunsSubscription`; closed once on unmount. */
export interface AgentRunSubscription {
  /** Add a listener. Returns an `off` callable that detaches
   *  the listener WITHOUT closing the underlying SSE client. */
  subscribe: SubscribeToAgentRuns;
  /** Close the underlying SSE client and clear all listeners.
   *  Called by the parent component's unmount effect. */
  close(): void;
}

/** Construct a shared `agent_run` subscription. The underlying
 *  SSE client is opened LAZILY on the first `subscribe(handler)`
 *  call — a parent that never renders a button doesn't open the
 *  pipe at all. Every subsequent `subscribe` adds the handler to
 *  the in-memory listener set without re-opening; only `close()`
 *  tears the SSE client down.
 *
 *  Production callers wire one of these per page mount via
 *  `useMemo` and dispose via a `useEffect` cleanup. */
export function createAgentRunsSubscription(): AgentRunSubscription {
  const listeners = new Set<(evt: AgentRunEvent) => void>();
  let client: SseClient | null = null;
  let detachClient: (() => void) | null = null;
  let closed = false;

  function ensureClient(): void {
    if (client !== null || closed) return;
    client = openSseClient("/api/admin/events");
    // Single SSE listener fans out to every registered handler;
    // the `agent_run` frame carries `startedAt` too (we discard
    // it to keep AgentRunEvent slim — the button doesn't need it).
    detachClient = client.on<{
      runId: string;
      definitionSlug: string;
      status: string;
      startedAt: string;
    }>("agent_run", (evt) => {
      const projected: AgentRunEvent = {
        runId: evt.data.runId,
        definitionSlug: evt.data.definitionSlug,
        status: evt.data.status,
      };
      // Snapshot so a handler that calls subscribe()/off()
      // mid-dispatch doesn't mutate the iteration target.
      for (const handler of [...listeners]) {
        handler(projected);
      }
    });
  }

  return {
    subscribe(handler) {
      listeners.add(handler);
      ensureClient();
      return (): void => {
        listeners.delete(handler);
      };
    },
    close(): void {
      if (closed) return;
      closed = true;
      listeners.clear();
      detachClient?.();
      detachClient = null;
      client?.close();
      client = null;
    },
  };
}

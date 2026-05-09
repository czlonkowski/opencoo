/**
 * `createAgentRunsSubscription` — shared SSE subscription helper
 * (PR-R3 fix-up Issue A).
 *
 * Pin matrix:
 *   1. ONE underlying SSE pipe is opened (regardless of how many
 *      handlers subscribe).
 *   2. The SSE pipe is opened LAZILY on the first `subscribe`
 *      call — a parent that never renders a button doesn't pay
 *      for a `globalThis.fetch` call against `/api/admin/events`.
 *   3. Two handlers receive the same dispatched event.
 *   4. Per-listener `off()` removes ONE handler; the remaining
 *      handler still receives subsequent events; the SSE pipe
 *      stays open.
 *   5. `close()` clears all listeners and closes the underlying
 *      SSE client (subsequent fake events are not dispatched).
 *
 * Strategy: the same controllable `globalThis.fetch` harness used
 * by `sse.test.ts` (push raw SSE wire-format chunks into a
 * ReadableStream that backs the Response). `agent_run` frames
 * project down to the slim `AgentRunEvent` shape the button
 * consumes.
 */
import { ReadableStream } from "node:stream/web";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import {
  createAgentRunsSubscription,
  type AgentRunEvent,
} from "../../src/lib/agent-runs-subscription.js";
import { setPat, clearPat } from "../../src/lib/pat-store.js";

// ─── Test harness (mirrors sse.test.ts) ──────────────────────────────────────

interface StreamHandle {
  push(chunk: string): void;
  end(): void;
  readonly signal: AbortSignal;
}

interface FetchHarness {
  next(): Promise<StreamHandle>;
  readonly attempts: readonly StreamHandle[];
}

function installFetchHarness(): FetchHarness {
  const attempts: StreamHandle[] = [];
  const waiters: Array<(h: StreamHandle) => void> = [];
  const fetchMock: Mock = vi.fn(
    async (
      _url: string,
      init: RequestInit & { signal?: AbortSignal },
    ): Promise<Response> => {
      let push!: (chunk: string) => void;
      let end!: () => void;
      const stream = new ReadableStream<Uint8Array>({
        start(controller): void {
          push = (chunk: string): void => {
            controller.enqueue(new TextEncoder().encode(chunk));
          };
          end = (): void => {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          };
        },
      });
      const signal = init.signal ?? new AbortController().signal;
      const handle: StreamHandle = { push, end, signal };
      attempts.push(handle);
      const w = waiters.shift();
      if (w !== undefined) w(handle);
      // node:stream/web's ReadableStream is structurally assignable
      // to the DOM ReadableStream lib expects, but TS's
      // `exactOptionalPropertyTypes` rejects the direct assignment
      // — same cast pattern as `sse.test.ts`.
      return new Response(stream as unknown as BodyInit, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  );
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch;
  return {
    next(): Promise<StreamHandle> {
      const ready = attempts.find(() => true);
      if (ready !== undefined) {
        // Pop the next un-yielded handle. Simpler: just yield
        // the most recent — tests await one connection at a time.
        return Promise.resolve(attempts[attempts.length - 1]!);
      }
      return new Promise<StreamHandle>((resolve) => waiters.push(resolve));
    },
    attempts,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("createAgentRunsSubscription", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    setPat("test-pat");
  });

  afterEach(() => {
    clearPat();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  });

  it("does NOT open the SSE pipe until the first subscribe call", () => {
    const fetchSpy = vi.fn();
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchSpy as unknown as typeof fetch;

    const sub = createAgentRunsSubscription();

    // No subscribers → no fetch.
    expect(fetchSpy).not.toHaveBeenCalled();

    sub.close();
  });

  it("opens exactly ONE SSE pipe even when multiple handlers subscribe", async () => {
    const harness = installFetchHarness();
    const sub = createAgentRunsSubscription();

    sub.subscribe(() => undefined);
    sub.subscribe(() => undefined);
    sub.subscribe(() => undefined);

    // Wait a microtask so the lazy fetch lands.
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.attempts.length).toBe(1);

    sub.close();
  });

  it("dispatches ONE wire frame to ALL registered handlers", async () => {
    const harness = installFetchHarness();
    const sub = createAgentRunsSubscription();

    const received1: AgentRunEvent[] = [];
    const received2: AgentRunEvent[] = [];
    sub.subscribe((evt) => received1.push(evt));
    sub.subscribe((evt) => received2.push(evt));

    const handle = await harness.next();
    handle.push(
      `event: agent_run\ndata: {"runId":"r-1","definitionSlug":"lint","status":"running","startedAt":"2026-01-01T00:00:00Z"}\n\n`,
    );

    // Yield until the parser dispatches.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    expect(received1).toEqual([
      { runId: "r-1", definitionSlug: "lint", status: "running" },
    ]);
    expect(received2).toEqual([
      { runId: "r-1", definitionSlug: "lint", status: "running" },
    ]);

    sub.close();
  });

  it("per-listener off() removes only THAT handler; pipe stays open", async () => {
    const harness = installFetchHarness();
    const sub = createAgentRunsSubscription();

    const received1: AgentRunEvent[] = [];
    const received2: AgentRunEvent[] = [];
    const off1 = sub.subscribe((evt) => received1.push(evt));
    sub.subscribe((evt) => received2.push(evt));

    const handle = await harness.next();
    handle.push(
      `event: agent_run\ndata: {"runId":"r-1","definitionSlug":"lint","status":"running","startedAt":"2026-01-01T00:00:00Z"}\n\n`,
    );
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);

    off1();

    handle.push(
      `event: agent_run\ndata: {"runId":"r-2","definitionSlug":"lint","status":"success","startedAt":"2026-01-01T00:00:01Z"}\n\n`,
    );
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    // Handler 1 detached; Handler 2 still receives.
    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(2);

    // SSE pipe still alive — only ONE fetch attempt total.
    expect(harness.attempts.length).toBe(1);

    sub.close();
  });

  it("close() detaches all listeners AND aborts the underlying SSE client", async () => {
    const harness = installFetchHarness();
    const sub = createAgentRunsSubscription();

    const received: AgentRunEvent[] = [];
    sub.subscribe((evt) => received.push(evt));

    const handle = await harness.next();
    handle.push(
      `event: agent_run\ndata: {"runId":"r-1","definitionSlug":"lint","status":"running","startedAt":"2026-01-01T00:00:00Z"}\n\n`,
    );
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(received).toHaveLength(1);

    sub.close();

    // The underlying client.close() aborts the in-flight fetch
    // signal; even if the server keeps writing, no further events
    // dispatch to the cleared listener set.
    expect(handle.signal.aborted).toBe(true);

    // Subsequent close() is idempotent.
    sub.close();
  });
});

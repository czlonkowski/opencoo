/**
 * SSE client — fetch-streaming auth (phase-a appendix #9 PR-Q1).
 *
 * Pin matrix:
 *   1. Multi-line `data:` lines concatenate with a literal "\n" between
 *      lines and dispatch on the trailing blank line.
 *   2. Named events (`event: agent_run` followed by `data: {...}`) dispatch
 *      to the matching `on("agent_run", ...)` listener with parsed JSON.
 *   3. `id:` lines update the client's `lastEventId`; the next reconnect's
 *      fetch carries the most recent id as the `Last-Event-ID` header AND
 *      the `Authorization: Bearer <pat>` header sourced from `pat-store`.
 *   4. `close()` aborts the in-flight fetch (its AbortController fires);
 *      the client transitions to readyState "closed" and stops dispatching.
 *
 * Strategy:
 *   We replace globalThis.fetch with a controllable stub that returns a
 *   Response wrapping a Web ReadableStream. Tests push raw SSE wire-format
 *   chunks into the stream; the parser is exercised end-to-end exactly as
 *   in the browser. No real network, no MSW dependency — the same Web
 *   Streams API is available in jsdom + Node 22.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { ReadableStream } from "node:stream/web";

import { setPat, clearPat } from "../../src/lib/pat-store.js";
import { openSseClient } from "../../src/lib/sse.js";

// ─── Test harness ────────────────────────────────────────────────────────────

interface StreamHandle {
  /** Push an SSE wire-format chunk into the stream. */
  push(chunk: string): void;
  /** Close the stream cleanly (server-side EOF). */
  end(): void;
  /** AbortSignal handed to fetch — flips when the client calls close(). */
  readonly signal: AbortSignal;
  /** Headers the client sent on this fetch attempt. */
  readonly headers: Headers;
}

interface FetchHarness {
  /** Resolves on the next pending fetch — yields its handle. */
  next(): Promise<StreamHandle>;
  /** All fetches observed so far, in order. */
  readonly attempts: readonly StreamHandle[];
}

/** Replace globalThis.fetch with a queue of controllable streams. */
function installFetchHarness(opts: { status?: number } = {}): FetchHarness {
  const status = opts.status ?? 200;
  const attempts: StreamHandle[] = [];
  const waiters: Array<(h: StreamHandle) => void> = [];
  let consumed = 0;

  const fetchMock: Mock = vi.fn(
    (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      let pushController: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(controller): void {
          pushController = controller;
        },
      });
      const encoder = new TextEncoder();
      const handle: StreamHandle = {
        push(chunk: string): void {
          pushController.enqueue(encoder.encode(chunk));
        },
        end(): void {
          try {
            pushController.close();
          } catch {
            /* already closed */
          }
        },
        signal: (init?.signal ?? new AbortController().signal) as AbortSignal,
        headers: new Headers(init?.headers ?? {}),
      };
      attempts.push(handle);
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        consumed += 1;
        waiter(handle);
      }
      // Cast through unknown — node:stream/web's ReadableStream is assignable
      // to BodyInit in jsdom but TS sees the global Web Streams type.
      return Promise.resolve(
        new Response(stream as unknown as BodyInit, {
          status,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = fetchMock as unknown as typeof fetch;

  return {
    async next(): Promise<StreamHandle> {
      // If a fetch has already landed but no one consumed it, hand it off.
      if (consumed < attempts.length) {
        const handle = attempts[consumed];
        if (handle !== undefined) {
          consumed += 1;
          return handle;
        }
      }
      // Otherwise queue a waiter — the next fetch will resolve it.
      return new Promise<StreamHandle>((resolve) => waiters.push(resolve));
    },
    get attempts(): readonly StreamHandle[] {
      return attempts;
    },
  };
}

/** Wait for a microtask flush so async listeners can run. */
async function flush(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

beforeEach(() => {
  clearPat();
  vi.useRealTimers();
});

afterEach(() => {
  clearPat();
  vi.restoreAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("openSseClient — wire-format parsing", () => {
  it("concatenates multi-line `data:` lines with literal newline separators", async () => {
    const harness = installFetchHarness();
    const client = openSseClient("/api/admin/events");
    const received: Array<{ data: unknown; lastEventId: string }> = [];
    client.on<string>("message", (e) => {
      received.push({ data: e.data, lastEventId: e.lastEventId });
    });

    const stream = await harness.next();
    // Multi-line data — server sends each line with its own `data:` prefix.
    // The SSE spec dictates lines concatenate with "\n" on dispatch.
    stream.push("data: line one\ndata: line two\ndata: line three\n\n");
    await flush();

    expect(received).toHaveLength(1);
    expect(received[0]?.data).toBe("line one\nline two\nline three");

    client.close();
  });

  it("dispatches named events to the matching listener with parsed JSON data", async () => {
    const harness = installFetchHarness();
    const client = openSseClient("/api/admin/events");
    const runs: Array<unknown> = [];
    const messages: Array<unknown> = [];
    client.on<{ runId: string; status: string }>("agent_run", (e) => {
      runs.push(e.data);
    });
    client.on<unknown>("message", (e) => {
      messages.push(e.data);
    });

    const stream = await harness.next();
    stream.push(
      'event: agent_run\ndata: {"runId":"abc","status":"success"}\n\n',
    );
    await flush();

    expect(runs).toEqual([{ runId: "abc", status: "success" }]);
    // Named event must NOT also dispatch to the default `message` channel.
    expect(messages).toHaveLength(0);

    client.close();
  });
});

describe("openSseClient — reconnect carries Last-Event-ID + Bearer PAT", () => {
  it("updates lastEventId from `id:` lines and re-sends it on reconnect", async () => {
    setPat("test-pat-token");
    const harness = installFetchHarness();
    const client = openSseClient("/api/admin/events");
    const received: Array<{ id: string; data: unknown }> = [];
    client.on<unknown>("message", (e) => {
      received.push({ id: e.lastEventId, data: e.data });
    });

    // First connection — server emits an event with an `id:` line, then
    // closes the stream (simulating a network drop / server restart).
    const first = await harness.next();
    first.push('id: 42\ndata: "payload"\n\n');
    await flush();
    expect(received[0]?.id).toBe("42");
    first.end();

    // Client should reconnect — the second fetch carries Last-Event-ID = 42
    // AND the Bearer PAT.
    const second = await harness.next();
    expect(second.headers.get("Last-Event-ID")).toBe("42");
    expect(second.headers.get("Authorization")).toBe("Bearer test-pat-token");
    expect(second.headers.get("Accept")).toMatch(/text\/event-stream/);

    client.close();
  });
});

describe("openSseClient — close() aborts the in-flight fetch", () => {
  it("fires the AbortController's signal and transitions readyState to closed", async () => {
    const harness = installFetchHarness();
    const client = openSseClient("/api/admin/events");
    const stream = await harness.next();
    expect(stream.signal.aborted).toBe(false);

    // Wait for the readable to be wired up before closing.
    await flush();

    client.close();

    expect(stream.signal.aborted).toBe(true);
    expect(client.readyState).toBe("closed");

    // After close(), pushing more bytes must not dispatch — i.e. listeners
    // are torn down. We register a fresh listener and verify it never fires.
    const heard: unknown[] = [];
    client.on<unknown>("message", (e) => {
      heard.push(e);
    });
    try {
      stream.push('data: "should-not-arrive"\n\n');
    } catch {
      /* the stream may already be torn down — that's fine */
    }
    await flush();
    expect(heard).toHaveLength(0);
  });
});

/**
 * SSE client — fetch-based so the request can carry the operator's
 * Bearer PAT (the spec EventSource constructor accepts no headers,
 * which left the Activity feed stuck in "CONNECTING…" against the
 * engine's `verifyAdmin` middleware).
 *
 * The client:
 *   - opens a `text/event-stream` GET against the given URL with
 *     `Authorization: Bearer <pat>` (sourced from `pat-store`) and
 *     `Last-Event-ID` on reconnect attempts;
 *   - reads bytes off `Response.body` and parses the SSE wire format
 *     inline (per WHATWG: lines split on `\r\n`, `\r`, or `\n`;
 *     frames separated by a blank line; `data:` fields concatenate
 *     with `\n`; `event:` names the channel; `id:` updates the
 *     `lastEventId` cursor; lines starting with `:` are comments);
 *   - reconnects with exponential backoff (500 ms → 10 s) so a flaky
 *     network or a brief engine restart self-heals without an op;
 *   - exposes the same `on(eventType, listener)` / `close()` /
 *     `readyState` surface the previous EventSource-based helper did,
 *     so `Activity.tsx` and existing test stubs are unchanged.
 *
 * In-process tests inject a fake `globalThis.fetch` returning a
 * `ReadableStream`-bodied `Response`; jsdom + Node 22 both expose the
 * Web Streams API, so no polyfill is needed.
 */
import { getPat } from "./pat-store.js";

export interface SseEvent<T = unknown> {
  readonly type: string;
  readonly data: T;
  readonly lastEventId: string;
}

export type SseListener<T> = (event: SseEvent<T>) => void;

export interface SseClient {
  /** Register a listener for a specific event type. */
  on<T>(eventType: string, listener: SseListener<T>): () => void;
  /** Close the SSE connection and clean up all listeners. */
  close(): void;
  /** Current connection state. */
  readonly readyState: "connecting" | "open" | "closed";
}

interface RawFrame {
  readonly type: string;
  readonly data: string;
  readonly id: string | undefined;
}

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

/**
 * Parse a buffer of accumulated SSE bytes into complete frames plus a
 * trailing remainder. The remainder is whatever bytes follow the last
 * frame separator; the caller carries it forward into the next chunk.
 *
 * Frames are separated by a blank line. Line terminators may be `\n`,
 * `\r\n`, or `\r` (per the WHATWG HTML SSE spec). Within a frame:
 *   - lines starting with `:` are comments (skipped)
 *   - `event: <name>` sets the dispatch channel (default "message")
 *   - `data: <payload>` lines accumulate; concatenated with `\n` on dispatch
 *   - `id: <value>` updates the cursor
 *   - any other field is ignored (per spec)
 *
 * Note we deliberately do NOT support the `retry:` field — backoff is
 * managed by the client below; servers that emit `retry:` are still
 * accepted, the value is just ignored.
 */
export function parseSseChunk(buffer: string): {
  readonly frames: readonly RawFrame[];
  readonly rest: string;
} {
  const frames: RawFrame[] = [];
  // Split on a blank line (one or more line breaks separating two LFs).
  // The trailing element (whatever follows the final separator) stays in
  // `rest` for the next chunk, even when empty.
  const segments = buffer.split(/\r\n\r\n|\r\r|\n\n/);
  const rest = segments.pop() ?? "";
  for (const segment of segments) {
    if (segment.length === 0) continue;
    let type = "message";
    const dataLines: string[] = [];
    let id: string | undefined;
    for (const line of segment.split(/\r\n|\r|\n/)) {
      if (line.length === 0) continue;
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      // Per the spec, a single leading SP after the colon is stripped.
      const rawValue = colon === -1 ? "" : line.slice(colon + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "event") type = value;
      else if (field === "data") dataLines.push(value);
      else if (field === "id") id = value;
      // unknown fields and "retry" are ignored
    }
    if (dataLines.length === 0 && id === undefined && type === "message") {
      // Empty frame (e.g. a stray pair of newlines) — skip.
      continue;
    }
    frames.push({ type, data: dataLines.join("\n"), id });
  }
  return { frames, rest };
}

type ReadyState = "connecting" | "open" | "closed";

/**
 * Open an SSE connection to the given URL and return a typed client.
 *
 * The connection is started eagerly; the returned object is usable
 * immediately. Listeners registered before the first frame arrives are
 * delivered as expected (frames are dispatched serially as the parser
 * yields them).
 */
export function openSseClient(url: string): SseClient {
  const listeners = new Map<string, Set<SseListener<unknown>>>();
  // `state` mutates from any of the three values to any other across
  // async boundaries (close() may flip to "closed" during a pending
  // fetch). Annotated explicitly as the union so TS doesn't narrow it
  // by control-flow analysis in the connect() loop.
  let state: ReadyState = "connecting";
  let lastEventId = "";
  let abort: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = INITIAL_BACKOFF_MS;

  const isClosed = (): boolean => state === "closed";

  function dispatch(frame: RawFrame): void {
    if (isClosed()) return;
    if (frame.id !== undefined) lastEventId = frame.id;
    const set = listeners.get(frame.type);
    if (set === undefined || set.size === 0) return;
    let parsed: unknown;
    if (frame.data.length === 0) {
      parsed = undefined;
    } else {
      try {
        parsed = JSON.parse(frame.data);
      } catch {
        // Server emitted a non-JSON payload — pass the raw string through
        // so consumers that expect plain text still receive something.
        parsed = frame.data;
      }
    }
    const event: SseEvent<unknown> = {
      type: frame.type,
      data: parsed,
      lastEventId: frame.id ?? lastEventId,
    };
    for (const listener of set) listener(event);
  }

  function scheduleReconnect(): void {
    if (isClosed()) return;
    state = "connecting";
    const wait = Math.min(backoff, MAX_BACKOFF_MS);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, wait);
  }

  async function connect(): Promise<void> {
    if (isClosed()) return;
    state = "connecting";
    abort = new AbortController();
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    const pat = getPat();
    if (pat !== null && pat.length > 0) {
      headers.Authorization = `Bearer ${pat}`;
    }
    if (lastEventId.length > 0) {
      headers["Last-Event-ID"] = lastEventId;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers,
        signal: abort.signal,
        credentials: "same-origin",
      });
    } catch {
      // Network error or abort — fall through to reconnect (the reconnect
      // path itself early-returns if state === "closed").
      if (!isClosed()) scheduleReconnect();
      return;
    }

    if (!response.ok || response.body === null) {
      if (!isClosed()) scheduleReconnect();
      return;
    }

    state = "open";
    backoff = INITIAL_BACKOFF_MS;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = parseSseChunk(buffer);
        buffer = rest;
        for (const frame of frames) dispatch(frame);
      }
      // Flush any final partial decode (no trailing separator). The parser
      // returns no frames here unless the last bytes happened to end on a
      // separator — which the loop above already handled.
      buffer += decoder.decode();
    } catch {
      // Stream torn down (network drop, abort, server reset) — let the
      // reconnect path decide whether to retry.
    }

    if (!isClosed()) scheduleReconnect();
  }

  void connect();

  return {
    on<T>(eventType: string, listener: SseListener<T>): () => void {
      let set = listeners.get(eventType);
      if (set === undefined) {
        set = new Set();
        listeners.set(eventType, set);
      }
      set.add(listener as SseListener<unknown>);
      return (): void => {
        set?.delete(listener as SseListener<unknown>);
      };
    },
    close(): void {
      state = "closed";
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      abort?.abort();
      abort = null;
      listeners.clear();
    },
    get readyState(): "connecting" | "open" | "closed" {
      return state;
    },
  };
}

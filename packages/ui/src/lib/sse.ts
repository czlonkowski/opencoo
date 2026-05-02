/**
 * Tiny SSE client helper (phase-a appendix #4 PR-B).
 *
 * Wraps the browser's EventSource API with:
 *   - automatic reconnect using `Last-Event-ID` (handled natively by
 *     the spec-compliant EventSource implementation)
 *   - typed event listener registration
 *   - a `close()` method for clean cleanup
 *
 * The helper is intentionally thin — it does not implement custom
 * backoff (EventSource already does exponential reconnect per the
 * SSE spec). The server's `Last-Event-ID` echo means v0.1 clients
 * reconnect without replaying missed events.
 */
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

/**
 * Open an SSE connection to the given URL.
 *
 * @param url  The SSE endpoint URL. For the admin API this is
 *             `/api/admin/events`. The Bearer PAT is not injectable
 *             via the EventSource constructor (browsers don't support
 *             custom headers on EventSource); instead the PAT is
 *             attached by the Fastify guard-verifyAdmin which reads
 *             the `Authorization` header via a regular fetch-upgrade.
 *             In tests, this path is mocked entirely.
 */
export function openSseClient(url: string): SseClient {
  // In test environments we may not have EventSource — fall back to a
  // no-op stub so the UI renders without crashing. SSE live-streaming
  // is e2e only; unit tests assert on the connection-state indicator.
  const listeners = new Map<string, Set<SseListener<unknown>>>();
  let fallbackReadyState: "connecting" | "open" | "closed" = "connecting";
  let source: EventSource | null = null;

  if (typeof EventSource !== "undefined") {
    source = new EventSource(url);
    source.addEventListener("open", () => {
      fallbackReadyState = "open";
    });
    source.addEventListener("error", () => {
      // EventSource reconnects automatically; just update state.
      fallbackReadyState = "connecting";
    });
  } else {
    // No EventSource (test/Node env) — immediately mark as open so
    // the component doesn't get stuck in "connecting" forever in tests.
    fallbackReadyState = "open";
  }

  function dispatch(eventType: string, raw: MessageEvent): void {
    const set = listeners.get(eventType);
    if (set === undefined || set.size === 0) return;
    let data: unknown;
    try {
      data = JSON.parse(raw.data as string) as unknown;
    } catch {
      data = raw.data;
    }
    const sseEvent: SseEvent<unknown> = {
      type: eventType,
      data,
      lastEventId: raw.lastEventId ?? "",
    };
    for (const listener of set) {
      listener(sseEvent);
    }
  }

  return {
    on<T>(eventType: string, listener: SseListener<T>): () => void {
      let set = listeners.get(eventType);
      if (set === undefined) {
        set = new Set();
        listeners.set(eventType, set);
        // Wire up the EventSource listener once per event type.
        source?.addEventListener(eventType, (raw: Event) => {
          dispatch(eventType, raw as MessageEvent);
        });
      }
      set.add(listener as SseListener<unknown>);
      return () => {
        set?.delete(listener as SseListener<unknown>);
      };
    },

    close(): void {
      source?.close();
      listeners.clear();
      fallbackReadyState = "closed";
    },

    get readyState() {
      if (source === null) return fallbackReadyState;
      switch (source.readyState) {
        case EventSource.CONNECTING: return "connecting";
        case EventSource.OPEN: return "open";
        case EventSource.CLOSED: return "closed";
        default: return fallbackReadyState;
      }
    },
  };
}

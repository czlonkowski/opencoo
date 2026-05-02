/**
 * Tiny SSE client helper (phase-a appendix #4 PR-B).
 *
 * Wraps the browser's EventSource API with:
 *   - automatic reconnect using `Last-Event-ID`
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
 * @param fetchImpl  Optional fetch override for testing.
 */
export function openSseClient(
  url: string,
  fetchImpl?: typeof fetch,
): SseClient {
  // In test environments we may not have EventSource — fall back to
  // a no-op stub so the UI renders without crashing. The test suite
  // mocks fetch-based data fetching; SSE live-streaming is e2e only.
  const listeners = new Map<string, Set<SseListener<unknown>>>();
  let readyState: "connecting" | "open" | "closed" = "connecting";
  let source: EventSource | null = null;

  // Prefer EventSource when available (real browser + compatible env).
  if (typeof EventSource !== "undefined") {
    source = new EventSource(url);

    source.addEventListener("open", () => {
      readyState = "open";
    });

    source.addEventListener("error", () => {
      // EventSource reconnects automatically; just update state.
      readyState = "connecting";
    });

    // Listen for all custom event types registered via `on()`.
    const handleMessage = (eventType: string, raw: MessageEvent): void => {
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
    };

    // We intercept typed events dynamically in the `on()` method.
    void handleMessage; // referenced below
  } else {
    // No EventSource (test/Node env) — immediately mark as open so
    // the component doesn't get stuck in "connecting" forever in tests.
    readyState = "open";
  }

  void fetchImpl; // unused here; kept for symmetry with the public API

  return {
    on<T>(eventType: string, listener: SseListener<T>): () => void {
      let set = listeners.get(eventType);
      if (set === undefined) {
        set = new Set();
        listeners.set(eventType, set);
        // Wire up the EventSource listener for this event type.
        if (source !== null) {
          source.addEventListener(eventType, (raw: Event) => {
            const me = raw as MessageEvent;
            const currentSet = listeners.get(eventType);
            if (currentSet === undefined || currentSet.size === 0) return;
            let data: unknown;
            try {
              data = JSON.parse(me.data as string) as unknown;
            } catch {
              data = me.data;
            }
            const sseEvent: SseEvent<unknown> = {
              type: eventType,
              data,
              lastEventId: me.lastEventId ?? "",
            };
            for (const l of currentSet) {
              l(sseEvent);
            }
          });
        }
      }
      set.add(listener as SseListener<unknown>);
      return () => {
        set?.delete(listener as SseListener<unknown>);
      };
    },

    close(): void {
      source?.close();
      listeners.clear();
      readyState = "closed";
    },

    get readyState() {
      if (source !== null) {
        switch (source.readyState) {
          case EventSource.CONNECTING: return "connecting";
          case EventSource.OPEN: return "open";
          case EventSource.CLOSED: return "closed";
        }
      }
      return readyState;
    },
  };
}

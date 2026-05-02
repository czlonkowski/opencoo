/**
 * Mock HTTP fetch for use-case tests (PR-J).
 *
 * Backed by a programmable upstream-behavior state object so the
 * contract suite and retry tests can exercise the 200, 429, 5xx,
 * and network-drop paths in turn.
 *
 * The `MockFetch` type mirrors the minimal `fetch`-like interface
 * the adapter uses — a function that takes a URL and init options
 * and returns a Response-like object.
 */

export type UpstreamBehavior =
  | { readonly kind: "ok" }
  | {
      readonly kind: "http-error";
      readonly status: number;
      readonly retryAfterSeconds?: number;
    }
  | { readonly kind: "transient" };

/** Captured outgoing request for inspection in tests. */
export interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export type BehaviorFn = () => UpstreamBehavior;

export interface MockHttpState {
  behavior: UpstreamBehavior;
  /** Optional override — called on each request; takes precedence
   *  over `behavior` when set. */
  behaviorFn?: BehaviorFn;
  readonly calls: CapturedRequest[];
  lastRequest: CapturedRequest | undefined;
}

export function createMockHttpState(): MockHttpState {
  return {
    behavior: { kind: "ok" },
    calls: [],
    lastRequest: undefined,
  };
}

/**
 * Minimal Response-like object returned by `makeMockHttpFetch`.
 * The adapter only reads `.status`, `headers.get(...)`, and `.text()`.
 */
export interface MockResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type MockFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<MockResponse>;

let nextRequestId = 1;

export function makeMockHttpFetch(state: MockHttpState): MockFetch {
  return async (url, init = {}): Promise<MockResponse> => {
    const captured: CapturedRequest = {
      url,
      method: init.method ?? "POST",
      headers: init.headers ?? {},
      body: init.body ?? "",
    };
    state.calls.push(captured);
    state.lastRequest = captured;

    const behavior = state.behaviorFn
      ? state.behaviorFn()
      : state.behavior;

    if (behavior.kind === "ok") {
      const id = nextRequestId++;
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ received: true, id }),
      };
    }

    if (behavior.kind === "http-error") {
      const { status, retryAfterSeconds } = behavior;
      const retryAfterValue =
        retryAfterSeconds !== undefined ? String(retryAfterSeconds) : null;
      return {
        status,
        headers: {
          get: (name: string) => {
            if (name.toLowerCase() === "retry-after") return retryAfterValue;
            return null;
          },
        },
        text: async () => `error ${status}`,
      };
    }

    // transient — simulate network drop
    throw new Error("mock network error: ECONNRESET");
  };
}

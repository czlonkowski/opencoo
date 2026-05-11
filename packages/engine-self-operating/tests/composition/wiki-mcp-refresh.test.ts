/**
 * `pingRefreshAll` helper tests (phase-a appendix #12 PR-Z8, G10).
 *
 * Fire-and-forget POST to gitea-wiki-mcp-server's `/refresh-all`.
 * The helper MUST resolve cleanly on EVERY failure mode so a
 * misconfigured or slow MCP server cannot block opencoo's
 * domain-create flow.
 *
 * Pin matrix:
 *   1. Happy path: POST /refresh-all with the right URL + bearer
 *   2. Body shape: { repos: [...] } JSON-encoded
 *   3. Empty repos array → skipped, no fetch
 *   4. 5xx → resolves, NEVER throws
 *   5. 401 → resolves, NEVER throws
 *   6. Network failure → resolves, NEVER throws
 *   7. Trailing slash in baseUrl stripped before appending /refresh-all
 */
import { describe, it, expect, vi } from "vitest";
import { ConsoleLogger } from "@opencoo/shared/logger";

import { pingRefreshAll } from "../../src/composition/wiki-mcp-refresh.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

describe("pingRefreshAll (phase-a appendix #12 PR-Z8, G10)", () => {
  it("POSTs to /refresh-all with the configured bearer + JSON body", async () => {
    const fetchSpy = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://mcp.test:3000/refresh-all");
      expect((init.headers as Record<string, string>)["authorization"]).toBe(
        "Bearer token-xyz",
      );
      expect((init.headers as Record<string, string>)["content-type"]).toBe(
        "application/json",
      );
      const parsed = JSON.parse(init.body as string);
      expect(parsed.repos).toEqual([
        { slug: "exec", owner: "opencoo", name: "exec", aggregator: false },
      ]);
      return new Response(JSON.stringify({ ok: true, repos: ["exec"] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await pingRefreshAll(
      {
        baseUrl: "http://mcp.test:3000",
        bearerToken: "token-xyz",
        fetchImpl: fetchSpy,
      },
      [{ slug: "exec", owner: "opencoo", name: "exec", aggregator: false }],
      silentLogger(),
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("strips a trailing slash from baseUrl", async () => {
    const fetchSpy = vi.fn(
      async (url: string) => {
        expect(url).toBe("http://mcp.test:3000/refresh-all");
        return new Response("{}", { status: 200 });
      },
    ) as unknown as typeof fetch;
    await pingRefreshAll(
      {
        baseUrl: "http://mcp.test:3000///",
        bearerToken: "t",
        fetchImpl: fetchSpy,
      },
      [{ slug: "a", owner: "opencoo" }],
      silentLogger(),
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("skips dispatch (no fetch) when repos array is empty", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 })) as
      unknown as typeof fetch;
    await pingRefreshAll(
      {
        baseUrl: "http://mcp.test:3000",
        bearerToken: "t",
        fetchImpl: fetchSpy,
      },
      [],
      silentLogger(),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves (does NOT throw) on a 5xx response", async () => {
    const fetchSpy = vi.fn(async () => new Response("err", { status: 503 })) as
      unknown as typeof fetch;
    await expect(
      pingRefreshAll(
        {
          baseUrl: "http://mcp.test:3000",
          bearerToken: "t",
          fetchImpl: fetchSpy,
        },
        [{ slug: "exec", owner: "opencoo" }],
        silentLogger(),
      ),
    ).resolves.toBeUndefined();
  });

  it("resolves (does NOT throw) on a 401 response", async () => {
    const fetchSpy = vi.fn(async () => new Response("nope", { status: 401 })) as
      unknown as typeof fetch;
    await expect(
      pingRefreshAll(
        {
          baseUrl: "http://mcp.test:3000",
          bearerToken: "wrong",
          fetchImpl: fetchSpy,
        },
        [{ slug: "exec", owner: "opencoo" }],
        silentLogger(),
      ),
    ).resolves.toBeUndefined();
  });

  it("resolves (does NOT throw) on a network failure", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      pingRefreshAll(
        {
          baseUrl: "http://mcp.test:3000",
          bearerToken: "t",
          fetchImpl: fetchSpy,
        },
        [{ slug: "exec", owner: "opencoo" }],
        silentLogger(),
      ),
    ).resolves.toBeUndefined();
  });

  it("resolves (does NOT throw) on an abort/timeout", async () => {
    // Copilot triage (PR-Z8 follow-up): the previous version of this
    // test only checked `init.signal?.aborted` at call time, then
    // returned a Response after a 50ms sleep — `AbortSignal.timeout()`
    // never had a chance to wire its abort event to anything, so the
    // helper's catch-AbortError path was NEVER exercised. Now we
    // attach a real listener so the helper's `signal: AbortSignal.timeout(10)`
    // genuinely fires the rejection path the test claims to cover.
    const fetchSpy = vi.fn((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        if (init.signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
        // Never resolves on its own — relies on the signal firing.
      });
    }) as unknown as typeof fetch;
    await expect(
      pingRefreshAll(
        {
          baseUrl: "http://mcp.test:3000",
          bearerToken: "t",
          fetchImpl: fetchSpy,
          // Real AbortSignal.timeout(10) inside the helper will fire
          // well before any of vitest's default test timeouts; the
          // listener above translates that into the rejection the
          // helper's catch must swallow.
          timeoutMs: 10,
        },
        [{ slug: "exec", owner: "opencoo" }],
        silentLogger(),
      ),
    ).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

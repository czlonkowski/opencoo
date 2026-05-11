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
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      // Simulate an immediately-aborted request.
      if (init.signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      // Wait long enough for the helper's 10ms timeout (configured
      // via opts.timeoutMs) to fire.
      await new Promise((r) => setTimeout(r, 50));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      pingRefreshAll(
        {
          baseUrl: "http://mcp.test:3000",
          bearerToken: "t",
          fetchImpl: fetchSpy,
          timeoutMs: 10,
        },
        [{ slug: "exec", owner: "opencoo" }],
        silentLogger(),
      ),
    ).resolves.toBeUndefined();
  });
});

import { describe, it, expect, vi } from "vitest";

import { createGiteaScopeChecker } from "../../src/services/scope-checker.js";

// pgMock Gitea `/repos/{owner}/{name}` endpoint. 200 = allowed; 404 = denied
// (PAT doesn't have visibility on the repo, OR the repo doesn't exist —
// treated identically from the MCP server's perspective).
function mockFetch(
  status: number,
  opts: { delayMs?: number } = {},
): typeof fetch {
  return vi.fn(async () => {
    if (opts.delayMs !== undefined) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
    return new Response(status === 200 ? "{}" : "", { status });
  }) as unknown as typeof fetch;
}

describe("GiteaScopeChecker — allow/deny basics", () => {
  it("returns { allow: true } for a 200 response", async () => {
    const fetchImpl = mockFetch(200);
    const checker = createGiteaScopeChecker({
      giteaBaseUrl: "http://gitea.local",
      fetchImpl,
    });
    const result = await checker.check("tok1", "owner", "repo");
    expect(result.allow).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns { allow: false } for a 404 response (out-of-scope)", async () => {
    const fetchImpl = mockFetch(404);
    const checker = createGiteaScopeChecker({
      giteaBaseUrl: "http://gitea.local",
      fetchImpl,
    });
    const result = await checker.check("tok1", "owner", "repo");
    expect(result.allow).toBe(false);
  });

  it("returns { allow: false } for a 401 response", async () => {
    const fetchImpl = mockFetch(401);
    const checker = createGiteaScopeChecker({
      giteaBaseUrl: "http://gitea.local",
      fetchImpl,
    });
    const result = await checker.check("tok1", "owner", "repo");
    expect(result.allow).toBe(false);
  });
});

describe("GiteaScopeChecker — fail-closed", () => {
  it("returns { allow: false } on a 500 response (fail-closed)", async () => {
    const fetchImpl = mockFetch(500);
    const checker = createGiteaScopeChecker({
      giteaBaseUrl: "http://gitea.local",
      fetchImpl,
    });
    const result = await checker.check("tok1", "owner", "repo");
    expect(result.allow).toBe(false);
  });

  it("returns { allow: false } on a network error (fail-closed)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const checker = createGiteaScopeChecker({
      giteaBaseUrl: "http://gitea.local",
      fetchImpl,
    });
    const result = await checker.check("tok1", "owner", "repo");
    expect(result.allow).toBe(false);
  });
});

describe("GiteaScopeChecker — cache", () => {
  it("caches a decision: second check for the same (token, repo) does not re-fetch", async () => {
    const fetchImpl = mockFetch(200);
    const checker = createGiteaScopeChecker({
      giteaBaseUrl: "http://gitea.local",
      fetchImpl,
    });
    await checker.check("tok1", "owner", "repo");
    await checker.check("tok1", "owner", "repo");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("caches per (token, repo) — different repos cause separate fetches", async () => {
    const fetchImpl = mockFetch(200);
    const checker = createGiteaScopeChecker({
      giteaBaseUrl: "http://gitea.local",
      fetchImpl,
    });
    await checker.check("tok1", "owner", "repo-a");
    await checker.check("tok1", "owner", "repo-b");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("caches per token — cross-PAT does NOT leak a decision", async () => {
    // tok1 sees 200 (allowed); tok2 sees 404 (denied). Two distinct cache
    // entries even though repo is identical.
    const fetchImpl = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const auth = (arguments as unknown as { [k: number]: unknown })[1] as
        | { headers?: Record<string, string> }
        | undefined;
      const header = auth?.headers?.["Authorization"] ?? "";
      const status = header.includes("tok1") ? 200 : 404;
      return new Response(status === 200 ? "{}" : "", { status });
      void url;
    }) as unknown as typeof fetch;
    const checker = createGiteaScopeChecker({
      giteaBaseUrl: "http://gitea.local",
      fetchImpl,
    });
    const r1 = await checker.check("tok1", "owner", "repo");
    const r2 = await checker.check("tok2", "owner", "repo");
    expect(r1.allow).toBe(true);
    expect(r2.allow).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("GiteaScopeChecker — TTL expiry", () => {
  it("expires a cache entry after the TTL and re-fetches", async () => {
    const fetchImpl = mockFetch(200);
    const checker = createGiteaScopeChecker({
      giteaBaseUrl: "http://gitea.local",
      fetchImpl,
      ttlMs: 10, // very short for test speed
    });
    await checker.check("tok1", "owner", "repo");
    await new Promise((r) => setTimeout(r, 25));
    await checker.check("tok1", "owner", "repo");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("GiteaScopeChecker — invalidate", () => {
  it("invalidate(token) drops that token's cached decisions", async () => {
    const fetchImpl = mockFetch(200);
    const checker = createGiteaScopeChecker({
      giteaBaseUrl: "http://gitea.local",
      fetchImpl,
    });
    await checker.check("tok1", "owner", "repo-a");
    await checker.check("tok1", "owner", "repo-b");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    checker.invalidate("tok1");
    await checker.check("tok1", "owner", "repo-a");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("invalidate(token) does NOT affect other tokens", async () => {
    const fetchImpl = mockFetch(200);
    const checker = createGiteaScopeChecker({
      giteaBaseUrl: "http://gitea.local",
      fetchImpl,
    });
    await checker.check("tok1", "owner", "repo");
    await checker.check("tok2", "owner", "repo");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    checker.invalidate("tok1");
    // tok2 still cached — no new fetch.
    await checker.check("tok2", "owner", "repo");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // tok1 re-fetches.
    await checker.check("tok1", "owner", "repo");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

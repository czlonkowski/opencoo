/**
 * `HttpMcpToolClient` contract tests (PR-N3, phase-a appendix #6).
 *
 * Hand-rolled JSON-RPC 2.0 over `fetch` against the
 * gitea-wiki-mcp-server's `/mcp` endpoint. The client is a thin
 * transport layer over the same `McpToolClient` port the in-memory
 * fixture implements; the load-bearing assertions here are:
 *
 *   1. Bearer token attaches to every request via the
 *      `Authorization: Bearer ${token}` header.
 *   2. `readResource` round-trips the response body from
 *      `result.contents[0].text` (per MCP spec).
 *   3. JSON-RPC error -32602 with "not accessible" / "not found"
 *      surfaces as `McpResourceNotFoundError` (validation → DLQ);
 *      other JSON-RPC errors surface as `McpHttpError`.
 *   4. `listResources` returns sorted URIs from
 *      `result.resources[].uri`; `scheme` and `uriPrefix` filters
 *      apply CLIENT-SIDE.
 *   5. Network failures (fetch rejects, request timeout) surface
 *      as typed `McpHttpError`, not raw TypeError.
 *   6. Bearer token NEVER appears in any log payload.
 *   7. Error messages are `scrubPat`-scrubbed before logging
 *      (THREAT-MODEL §3.6 invariant 11).
 */
import { describe, expect, it, vi } from "vitest";

import type { Logger } from "@opencoo/shared/logger";

import {
  HttpMcpToolClient,
  McpHttpError,
  McpResourceNotFoundError,
} from "../../src/mcp-tool-client/index.js";

interface CapturedLog {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  data?: Record<string, unknown> | undefined;
}

function makeRecordingLogger(): {
  logger: Logger;
  records: CapturedLog[];
} {
  const records: CapturedLog[] = [];
  const push =
    (level: CapturedLog["level"]) =>
    (message: string, data?: Record<string, unknown>): void => {
      records.push({ level, message, data });
    };
  const logger = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  } as unknown as Logger;
  return { logger, records };
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** Build a `Response`-like object so the client can call
 *  `response.ok`, `response.status`, `response.json()`. */
function jsonResponse(
  body: unknown,
  opts: { status?: number } = {},
): Response {
  const status = opts.status ?? 200;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BEARER = "test-bearer-token-do-not-leak-1234567890abcdef";
const URL_BASE = "http://localhost:3000/mcp";

describe("HttpMcpToolClient — readResource", () => {
  it("POSTs JSON-RPC resources/read and round-trips contents[0].text", async () => {
    const calls: FetchCall[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init: init ?? {} });
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          contents: [
            { uri: "wiki://exec/index.md", mimeType: "text/markdown", text: "# index body" },
          ],
        },
      });
    });
    const { logger } = makeRecordingLogger();

    const client = new HttpMcpToolClient({
      baseUrl: URL_BASE,
      bearerToken: BEARER,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const body = await client.readResource("wiki://exec/index.md");
    expect(body).toBe("# index body");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(URL_BASE);
    expect(calls[0]?.init.method).toBe("POST");
    const parsed = JSON.parse(String(calls[0]?.init.body ?? "{}")) as {
      jsonrpc: string;
      method: string;
      params: { uri: string };
    };
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.method).toBe("resources/read");
    expect(parsed.params.uri).toBe("wiki://exec/index.md");
  });

  it("attaches `Authorization: Bearer ${token}` header on every request", async () => {
    const calls: FetchCall[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init: init ?? {} });
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { contents: [{ uri: "wiki://x/y.md", text: "ok" }] },
      });
    });
    const { logger } = makeRecordingLogger();
    const client = new HttpMcpToolClient({
      baseUrl: URL_BASE,
      bearerToken: BEARER,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await client.readResource("wiki://x/y.md");

    const headers = calls[0]?.init.headers as Record<string, string> | undefined;
    expect(headers).toBeDefined();
    // Headers may be a plain object, a Headers instance, or
    // [string, string][]. Coerce + assert the bearer is present.
    const headerObj = new Headers(headers);
    expect(headerObj.get("authorization")).toBe(`Bearer ${BEARER}`);
    expect(headerObj.get("content-type")).toMatch(/application\/json/);
  });

  it("maps JSON-RPC -32602 'not accessible' error to McpResourceNotFoundError", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32602,
          message: "resource not accessible",
        },
      }),
    );
    const { logger } = makeRecordingLogger();
    const client = new HttpMcpToolClient({
      baseUrl: URL_BASE,
      bearerToken: BEARER,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(
      client.readResource("wiki://exec/missing.md"),
    ).rejects.toBeInstanceOf(McpResourceNotFoundError);
  });

  it("maps JSON-RPC error with 'not found' message to McpResourceNotFoundError", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "Resource not found: wiki://x/y.md" },
      }),
    );
    const { logger } = makeRecordingLogger();
    const client = new HttpMcpToolClient({
      baseUrl: URL_BASE,
      bearerToken: BEARER,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(
      client.readResource("wiki://x/y.md"),
    ).rejects.toBeInstanceOf(McpResourceNotFoundError);
  });

  it("maps non-not-found JSON-RPC error to McpHttpError (not McpResourceNotFoundError)", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "internal server error" },
      }),
    );
    const { logger } = makeRecordingLogger();
    const client = new HttpMcpToolClient({
      baseUrl: URL_BASE,
      bearerToken: BEARER,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(client.readResource("wiki://x/y.md")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof McpHttpError &&
        !(err instanceof McpResourceNotFoundError) &&
        err.jsonRpcCode === -32603,
    );
  });

  it("maps a non-2xx HTTP response to McpHttpError carrying the status", async () => {
    const fetchFn = vi.fn(async () =>
      new Response("upstream gone", { status: 502 }),
    );
    const { logger } = makeRecordingLogger();
    const client = new HttpMcpToolClient({
      baseUrl: URL_BASE,
      bearerToken: BEARER,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(client.readResource("wiki://x/y.md")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof McpHttpError && err.httpStatus === 502,
    );
  });

  it("maps a fetch network failure to McpHttpError (not raw TypeError)", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });
    const { logger } = makeRecordingLogger();
    const client = new HttpMcpToolClient({
      baseUrl: URL_BASE,
      bearerToken: BEARER,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(client.readResource("wiki://x/y.md")).rejects.toBeInstanceOf(
      McpHttpError,
    );
  });

  it("aborts the request via AbortController when requestTimeoutMs elapses", async () => {
    // Capture the AbortSignal handed to fetch and resolve a never-
    // settling promise — the client's timer should fire and the
    // AbortError surface as McpHttpError.
    const fetchFn = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const { logger } = makeRecordingLogger();
    const client = new HttpMcpToolClient({
      baseUrl: URL_BASE,
      bearerToken: BEARER,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
      requestTimeoutMs: 25,
    });
    await expect(
      client.readResource("wiki://x/y.md"),
    ).rejects.toBeInstanceOf(McpHttpError);
  });
});

describe("HttpMcpToolClient — listResources", () => {
  it("POSTs JSON-RPC resources/list and returns sorted URIs from result.resources[].uri", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          resources: [
            { uri: "wiki://hr/index.md", name: "i" },
            { uri: "wiki://exec/index.md", name: "i" },
            { uri: "worldview://exec", name: "w" },
          ],
        },
      }),
    );
    const { logger } = makeRecordingLogger();
    const client = new HttpMcpToolClient({
      baseUrl: URL_BASE,
      bearerToken: BEARER,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const uris = await client.listResources();
    expect([...uris]).toEqual([
      "wiki://exec/index.md",
      "wiki://hr/index.md",
      "worldview://exec",
    ]);
  });

  it("filters by `scheme` client-side", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          resources: [
            { uri: "wiki://exec/index.md" },
            { uri: "wiki://hr/index.md" },
            { uri: "worldview://exec" },
          ],
        },
      }),
    );
    const { logger } = makeRecordingLogger();
    const client = new HttpMcpToolClient({
      baseUrl: URL_BASE,
      bearerToken: BEARER,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const wikis = await client.listResources({ scheme: "wiki" });
    expect([...wikis].sort()).toEqual([
      "wiki://exec/index.md",
      "wiki://hr/index.md",
    ]);
    const wv = await client.listResources({ scheme: "worldview" });
    expect([...wv]).toEqual(["worldview://exec"]);
  });

  it("filters by `uriPrefix` client-side", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          resources: [
            { uri: "wiki://exec/index.md" },
            { uri: "wiki://exec/team/eng.md" },
            { uri: "wiki://hr/index.md" },
          ],
        },
      }),
    );
    const { logger } = makeRecordingLogger();
    const client = new HttpMcpToolClient({
      baseUrl: URL_BASE,
      bearerToken: BEARER,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const filtered = await client.listResources({
      uriPrefix: "wiki://exec/",
    });
    expect([...filtered].sort()).toEqual([
      "wiki://exec/index.md",
      "wiki://exec/team/eng.md",
    ]);
  });

  it("attaches the bearer header on listResources too", async () => {
    const calls: FetchCall[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), init: init ?? {} });
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { resources: [] },
      });
    });
    const { logger } = makeRecordingLogger();
    const client = new HttpMcpToolClient({
      baseUrl: URL_BASE,
      bearerToken: BEARER,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await client.listResources();
    const headers = new Headers(
      calls[0]?.init.headers as Record<string, string> | undefined,
    );
    expect(headers.get("authorization")).toBe(`Bearer ${BEARER}`);
  });
});

describe("HttpMcpToolClient — credential leakage prevention (THREAT-MODEL §3.6 #11)", () => {
  it("NEVER includes the bearer token in any log payload (success path)", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { contents: [{ uri: "wiki://x/y.md", text: "ok" }] },
      }),
    );
    const { logger, records } = makeRecordingLogger();
    const client = new HttpMcpToolClient({
      baseUrl: URL_BASE,
      bearerToken: BEARER,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await client.readResource("wiki://x/y.md");
    // Every log line — at any level — must not reference the token.
    for (const r of records) {
      const serialized = JSON.stringify(r);
      expect(
        serialized,
        `bearer leaked into ${r.level} '${r.message}'`,
      ).not.toContain(BEARER);
    }
  });

  it("scrubs bearer-laced error messages via scrubPat before logging", async () => {
    // Simulate an upstream that echoes the inbound Authorization
    // header in its error message — the scrub should mask it.
    const fetchFn = vi.fn(async () => {
      throw new TypeError(
        `request to http://localhost:3000/mcp with Authorization: Bearer ${BEARER} failed`,
      );
    });
    const { logger, records } = makeRecordingLogger();
    const client = new HttpMcpToolClient({
      baseUrl: URL_BASE,
      bearerToken: BEARER,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(client.readResource("wiki://x/y.md")).rejects.toBeInstanceOf(
      McpHttpError,
    );
    // At least one warn record was written; none of them carry the bearer.
    const warnRecords = records.filter((r) => r.level === "warn");
    expect(warnRecords.length).toBeGreaterThan(0);
    for (const r of warnRecords) {
      const serialized = JSON.stringify(r);
      expect(serialized).not.toContain(BEARER);
      // The placeholder appears somewhere in the warn payload.
      expect(serialized).toContain("[REDACTED]");
    }
  });

  it("does NOT include the bearer in McpHttpError.message thrown at call sites", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError(
        `Bearer ${BEARER} got rejected by middleware`,
      );
    });
    const { logger } = makeRecordingLogger();
    const client = new HttpMcpToolClient({
      baseUrl: URL_BASE,
      bearerToken: BEARER,
      logger,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    let caught: unknown;
    try {
      await client.readResource("wiki://x/y.md");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpHttpError);
    expect((caught as Error).message).not.toContain(BEARER);
  });
});

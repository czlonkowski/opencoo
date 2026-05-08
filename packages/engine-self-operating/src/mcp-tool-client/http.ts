/**
 * `HttpMcpToolClient` — production transport for the McpToolClient
 * port. Speaks JSON-RPC 2.0 over HTTPS to an MCP server's `/mcp`
 * endpoint per the MCP Streamable-HTTP transport (PR-N3, phase-a
 * appendix #6).
 *
 * Used against TWO different MCP servers in v0.1, each constructed
 * via its own instance:
 *   1. gitea-wiki-mcp-server — `MCP_BEARER_TOKEN` + `MCP_BASE_URL`
 *      env vars; only `readResource` + `listResources` are called.
 *   2. n8n-mcp (PR-O3, appendix #7) — `N8N_MCP_BEARER_TOKEN` +
 *      `N8N_MCP_BASE_URL`; only `callTool('search_templates', ...)`
 *      is called for the Surfacer template catalog.
 *
 * Hand-rolled over `fetch` rather than wrapping
 * `@modelcontextprotocol/sdk/client` — the SDK transport drags in
 * SSE / batching machinery we don't need for v0.1's request/response
 * surface, and the additional dep would cross the
 * @opencoo/engine-self-operating workspace boundary unnecessarily.
 * A future PR can swap to the SDK if streaming or richer transport
 * features become useful.
 *
 * Three operations:
 *   - `readResource(uri)` → POST `${baseUrl}` with JSON-RPC
 *     `{ method: "resources/read", params: { uri } }`. Returns
 *     `result.contents[0].text` per the MCP spec.
 *   - `listResources(filter?)` → POST `${baseUrl}` with JSON-RPC
 *     `{ method: "resources/list", params: {} }`. Returns sorted
 *     URI array. `scheme` and `uriPrefix` filters apply
 *     CLIENT-SIDE — the gitea-wiki-mcp-server's resources/list
 *     handler does not declare server-side filter semantics.
 *   - `callTool(name, args?)` (PR-O3, appendix #7) → POST with
 *     JSON-RPC `{ method: "tools/call", params: { name, arguments }}`.
 *     Returns the JSON-RPC `result` envelope verbatim — per MCP
 *     spec the canonical shape is
 *     `{ content: [{ type: "text", text: "..." }] }` but the caller
 *     parses tool-specifically (e.g. n8n-mcp's `search_templates`
 *     ships its catalog as a JSON string inside the text content).
 *
 * Error mapping:
 *   - JSON-RPC error code -32602 with "not accessible" / "not
 *     found" in the message → throws `McpResourceNotFoundError`
 *     (validation → DLQ; mirrors the in-memory fixture's contract).
 *   - Other JSON-RPC errors → `McpHttpError` carrying `jsonRpcCode`
 *     + the safe message.
 *   - Non-2xx HTTP status → `McpHttpError` carrying `httpStatus`.
 *   - `fetch` network reject / abort → `McpHttpError` carrying the
 *     scrubbed cause message.
 *
 * Credential safety (THREAT-MODEL §2 invariant 11, §3.6 invariant
 * 11): the bearer token is attached to every outbound request via
 * the `Authorization` header, but NEVER appears in any log payload
 * or thrown error message. All inbound error strings — JSON-RPC
 * `error.message`, fetch reject `.message`, etc. — are passed
 * through `safeErrorMessage` (scrub + cap at 200 chars) before
 * being logged or wrapped, so an upstream service that echoes the
 * inbound `Authorization` header back to us cannot cause a leak.
 */
import type { Logger } from "@opencoo/shared/logger";
import { safeErrorMessage } from "@opencoo/shared/scrub";

import { McpHttpError } from "./errors.js";
import { McpResourceNotFoundError } from "./errors.js";
import type { McpListFilter, McpToolClient } from "./interface.js";

/** Default per-request timeout. Long enough that a slow
 *  gitea-wiki-mcp-server doesn't false-fail; short enough that a
 *  hung server doesn't block a lint run for minutes. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface HttpMcpToolClientOptions {
  /** Full URL of the MCP endpoint (e.g.
   *  `http://localhost:3000/mcp`). The client POSTs verbatim to
   *  this URL — it does not append `/mcp` itself; operators pass
   *  the complete path. */
  readonly baseUrl: string;
  /** Static bearer token. The same value the gitea-wiki-mcp-server
   *  is configured with via `MCP_BEARER_TOKEN`. Per architecture.md
   *  §10.2, v0.1 uses static-bearer for the engine-to-MCP path;
   *  per-PAT scoping is for the future Chat agent only. */
  readonly bearerToken: string;
  /** Logger handle. The client emits `mcp_http.request` at debug
   *  level on every successful request and `mcp_http.failed` at
   *  warn level on every error path. The bearer token NEVER
   *  appears in any payload. */
  readonly logger: Logger;
  /** @internal Test seam — defaults to global `fetch`. Tests
   *  inject a mock to assert request shape + simulate failures. */
  readonly fetchFn?: typeof fetch;
  /** Per-request timeout in milliseconds. Defaults to 30s. */
  readonly requestTimeoutMs?: number;
}

interface JsonRpcSuccessRead {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly result: {
    readonly contents: ReadonlyArray<{
      readonly uri: string;
      readonly mimeType?: string;
      readonly text?: string;
    }>;
  };
}

interface JsonRpcSuccessList {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly result: {
    readonly resources: ReadonlyArray<{ readonly uri: string }>;
  };
}

/** PR-O3: opaque success envelope for `tools/call`. The tool-specific
 *  shape lives under `result` (per MCP spec, typically
 *  `{ content: [{type:"text", text: ...}] }`) and is parsed by the
 *  caller, not here. */
interface JsonRpcSuccessTool {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly result: unknown;
}

interface JsonRpcError {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

type JsonRpcResponse =
  | JsonRpcSuccessRead
  | JsonRpcSuccessList
  | JsonRpcSuccessTool
  | JsonRpcError;

function isJsonRpcError(r: JsonRpcResponse): r is JsonRpcError {
  return (r as JsonRpcError).error !== undefined;
}


/** Map a JSON-RPC error to `McpResourceNotFoundError` only when
 *  the canonical "resource not accessible" / "not found" wire
 *  shape is present. Everything else routes to `McpHttpError`.
 *  Per the MCP spec, the gitea-wiki-mcp-server returns -32602
 *  (InvalidParams) for missing resources; we accept the broader
 *  message-keyword match because some servers normalise the
 *  message but not the code. */
function isNotFoundError(err: JsonRpcError["error"]): boolean {
  if (err.code !== -32602 && err.code !== -32600 && err.code !== -32001) {
    return false;
  }
  const m = (err.message ?? "").toLowerCase();
  return m.includes("not accessible") || m.includes("not found");
}

export class HttpMcpToolClient implements McpToolClient {
  private readonly baseUrl: string;
  private readonly bearerToken: string;
  private readonly logger: Logger;
  private readonly fetchFn: typeof fetch;
  private readonly requestTimeoutMs: number;
  private nextId = 1;

  constructor(options: HttpMcpToolClientOptions) {
    this.baseUrl = options.baseUrl;
    this.bearerToken = options.bearerToken;
    this.logger = options.logger;
    this.fetchFn = options.fetchFn ?? fetch;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async readResource(uri: string): Promise<string> {
    const t0 = Date.now();
    let response: JsonRpcResponse;
    try {
      response = await this.rpc("resources/read", { uri });
    } catch (err) {
      this.logFailed("readResource", uri, err);
      throw err;
    }
    if (isJsonRpcError(response)) {
      const safeMessage = safeErrorMessage(response.error.message);
      if (isNotFoundError(response.error)) {
        this.logger.warn("mcp_http.failed", {
          op: "readResource",
          uri,
          json_rpc_code: response.error.code,
          error: safeMessage,
        });
        throw new McpResourceNotFoundError(uri);
      }
      this.logger.warn("mcp_http.failed", {
        op: "readResource",
        uri,
        json_rpc_code: response.error.code,
        error: safeMessage,
      });
      throw new McpHttpError(
        `mcp-http: readResource '${uri}' failed (json-rpc ${response.error.code}: ${safeMessage})`,
        { jsonRpcCode: response.error.code },
      );
    }
    const contents = (response as JsonRpcSuccessRead).result.contents;
    const first = contents[0];
    const text = first?.text ?? "";
    this.logger.debug("mcp_http.request", {
      op: "readResource",
      uri,
      latency_ms: Date.now() - t0,
    });
    return text;
  }

  async listResources(
    filter?: McpListFilter,
  ): Promise<readonly string[]> {
    const t0 = Date.now();
    let response: JsonRpcResponse;
    try {
      response = await this.rpc("resources/list", {});
    } catch (err) {
      this.logFailed("listResources", undefined, err);
      throw err;
    }
    if (isJsonRpcError(response)) {
      const safeMessage = safeErrorMessage(response.error.message);
      this.logger.warn("mcp_http.failed", {
        op: "listResources",
        json_rpc_code: response.error.code,
        error: safeMessage,
      });
      throw new McpHttpError(
        `mcp-http: listResources failed (json-rpc ${response.error.code}: ${safeMessage})`,
        { jsonRpcCode: response.error.code },
      );
    }
    const resources = (response as JsonRpcSuccessList).result.resources ?? [];
    let uris = resources.map((r) => r.uri);
    if (filter !== undefined) {
      uris = uris.filter((uri) => {
        if (filter.scheme !== undefined) {
          const prefix = `${filter.scheme}://`;
          if (!uri.startsWith(prefix)) return false;
        }
        if (filter.uriPrefix !== undefined) {
          if (!uri.startsWith(filter.uriPrefix)) return false;
        }
        return true;
      });
    }
    uris.sort();
    this.logger.debug("mcp_http.request", {
      op: "listResources",
      latency_ms: Date.now() - t0,
      count: uris.length,
    });
    return uris;
  }

  /** Construct + send one JSON-RPC request. Returns the parsed
   *  response (success or json-rpc error) for the caller to
   *  branch on. Network failures, non-2xx HTTP, JSON-parse
   *  failures, and timeouts surface as `McpHttpError` BEFORE the
   *  caller is reached — so the only error type the caller can
   *  distinguish is the JSON-RPC `error` shape. */
  private async rpc(
    method: "resources/read" | "resources/list" | "tools/call",
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.requestTimeoutMs,
    );
    let response: Response;
    try {
      response = await this.fetchFn(this.baseUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.bearerToken}`,
          "content-type": "application/json",
          // MCP HTTP transport requires both content types per the
          // Streamable HTTP spec — gitea-wiki-mcp-server returns 406
          // when only `application/json` is offered.
          accept: "application/json, text/event-stream",
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      // Wrap any fetch reject / abort. The cause's `.message` may
      // contain the bearer if the upstream / middleware echoed it
      // — scrub before wrapping.
      const raw = err instanceof Error ? err.message : String(err);
      throw new McpHttpError(`mcp-http: ${method} fetch failed: ${safeErrorMessage(raw)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Non-2xx HTTP. Read the body best-effort for the log line
      // (capped + scrubbed); throw a typed error.
      let raw = "";
      try {
        raw = await response.text();
      } catch {
        raw = "";
      }
      throw new McpHttpError(
        `mcp-http: ${method} returned HTTP ${response.status}${
          raw ? ` (${safeErrorMessage(raw)})` : ""
        }`,
        { httpStatus: response.status },
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw new McpHttpError(
        `mcp-http: ${method} response was not valid JSON: ${safeErrorMessage(raw)}`,
      );
    }
    return parsed as JsonRpcResponse;
  }

  /** Centralised warn log for every failure path. Scrubs the
   *  inbound error message before serialisation so a bearer-laced
   *  upstream message can't leak via the log path. The
   *  `subjectKind` discriminates the URI-vs-tool-name field for
   *  the new callTool path (PR-O3); the `subject` value is logged
   *  under that key. */
  private logFailed(
    op: "readResource" | "listResources" | "callTool",
    subject: string | undefined,
    err: unknown,
    subjectKind: "uri" | "tool_name" = "uri",
  ): void {
    const raw = err instanceof Error ? err.message : String(err);
    const httpStatus =
      err instanceof McpHttpError ? err.httpStatus : undefined;
    this.logger.warn("mcp_http.failed", {
      op,
      ...(subject !== undefined ? { [subjectKind]: subject } : {}),
      ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
      error: safeErrorMessage(raw),
    });
  }

  /** PR-O3 (phase-a appendix #7) — invoke an MCP tool by name.
   *  Mirrors the readResource/listResources shape: rpc() returns
   *  the parsed response, JSON-RPC errors map to `McpHttpError`
   *  (no "tool not found" specialisation — Surfacer's caller
   *  treats every failure uniformly by falling back to the
   *  vendored catalog). Returns the JSON-RPC `result` envelope
   *  verbatim; the tool-specific shape is the caller's concern.
   *
   *  AbortController timer is cleared by the rpc() helper's
   *  finally block on every path — same discipline as
   *  readResource/listResources. */
  async callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<unknown> {
    const t0 = Date.now();
    let response: JsonRpcResponse;
    try {
      response = await this.rpc("tools/call", {
        name,
        arguments: args ?? {},
      });
    } catch (err) {
      this.logFailed("callTool", name, err, "tool_name");
      throw err;
    }
    if (isJsonRpcError(response)) {
      const safeMessage = safeErrorMessage(response.error.message);
      this.logger.warn("mcp_http.failed", {
        op: "callTool",
        tool_name: name,
        json_rpc_code: response.error.code,
        error: safeMessage,
      });
      throw new McpHttpError(
        `mcp-http: callTool '${name}' failed (json-rpc ${response.error.code}: ${safeMessage})`,
        { jsonRpcCode: response.error.code },
      );
    }
    this.logger.debug("mcp_http.tool_call", {
      tool_name: name,
      latency_ms: Date.now() - t0,
    });
    // Return the `result` envelope verbatim. Per MCP spec,
    // tools/call returns `{ content: [{type, text|data, ...}], ...}`
    // but the caller (e.g. listAvailableTemplateSlugs) is
    // responsible for the tool-specific parse — we keep the
    // transport layer free of any tool-specific schema knowledge.
    return (response as JsonRpcSuccessTool).result;
  }
}

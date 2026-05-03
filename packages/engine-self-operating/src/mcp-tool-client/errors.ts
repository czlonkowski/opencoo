import { OpencooError, type OpencooErrorOptions } from "@opencoo/shared/errors";

/**
 * The requested MCP resource URI is not available — the URI is
 * not registered (production: gitea-mcp returns InvalidRequest
 * "resource not accessible"; tests: the in-memory fixture has
 * no entry for this URI). Routed as `validation` so the run
 * DLQs — a missing resource is a config bug, not a transient
 * fault.
 */
export class McpResourceNotFoundError extends OpencooError {
  readonly uri: string;

  constructor(uri: string, options?: OpencooErrorOptions) {
    super(
      `mcp-tool-client: resource '${uri}' not found`,
      "validation",
      options,
    );
    this.name = "McpResourceNotFoundError";
    this.uri = uri;
  }
}

export interface McpHttpErrorOptions extends OpencooErrorOptions {
  /** HTTP status code from the response, when the failure was an
   *  HTTP-level error rather than a JSON-RPC error. */
  readonly httpStatus?: number;
  /** JSON-RPC `error.code` when the upstream returned a JSON-RPC
   *  error envelope. Distinct from `httpStatus` because the
   *  underlying HTTP request was 200 — the failure was at the
   *  protocol layer. */
  readonly jsonRpcCode?: number;
}

/**
 * Generic transport-layer error from `HttpMcpToolClient`. Used
 * for any failure that ISN'T the canonical "resource not
 * accessible" shape (which routes to `McpResourceNotFoundError`
 * for DLQ-on-config-bug semantics).
 *
 * Routed as `transient` — a 5xx, network blip, or json parse
 * failure is plausibly retry-worthy, and the harness's per-run
 * recorder will still terminalise the run as `failed` so the
 * Activity feed surfaces the issue.
 *
 * The thrown `.message` is ALREADY `scrubPat`-scrubbed by the
 * client before the error is constructed — callers can include
 * it verbatim in further log payloads without re-scrubbing.
 */
export class McpHttpError extends OpencooError {
  readonly httpStatus: number | undefined;
  readonly jsonRpcCode: number | undefined;

  constructor(message: string, options: McpHttpErrorOptions = {}) {
    super(message, "transient", options);
    this.name = "McpHttpError";
    this.httpStatus = options.httpStatus;
    this.jsonRpcCode = options.jsonRpcCode;
  }
}

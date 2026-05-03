/**
 * `McpToolClient` — port for read-only access to MCP-style
 * resources (wiki pages, worldview, index) served by the
 * gitea-wiki-mcp-server process.
 *
 * v0.1 ships only the port shape + an in-memory test fixture.
 * Production wires `HttpMcpToolClient` (PR 23+) which speaks the
 * MCP JSON-RPC protocol over HTTP to the out-of-process
 * gitea-mcp server. Per Q12, the in-memory fixture does NOT
 * import or expose gitea-mcp internals — it is a pure-data
 * test double conforming to the same shape, so engine-self-
 * operating remains decoupled from the gitea-mcp-server package.
 *
 * Two read operations + one optional tool-call operation:
 *   - `readResource(uri)` — fetch one resource body. Unknown
 *     URIs throw `McpResourceNotFoundError` (validation class,
 *     mirroring the MCP "resource not accessible" wire shape).
 *   - `listResources(filter?)` — enumerate available URIs with
 *     optional scheme + uriPrefix filters. v0.1 callers
 *     (Surfacer-style "find all `wiki://` resources for this
 *     domain") use the prefix path; the unfiltered call mostly
 *     exists for testing.
 *   - `callTool(name, args?)` — OPTIONAL invocation of an MCP
 *     tool by name (PR-O3, phase-a appendix #7). Implemented by
 *     `HttpMcpToolClient` + `InMemoryMcpToolClient`. The
 *     gitea-wiki-mcp-server doesn't expose tools (it's
 *     resource-only), so this is undefined on that client. The
 *     n8n-mcp client uses it for `search_templates` to enumerate
 *     the Surfacer template catalog at boot. Returns the
 *     parsed JSON-RPC `result` (shape varies per tool — callers
 *     defensively walk it).
 */
export interface McpListFilter {
  /** Filter to one URI scheme — e.g. `wiki`, `worldview`,
   *  `index`. The leading scheme without `://`. */
  readonly scheme?: string;
  /** Filter to URIs starting with this exact prefix —
   *  e.g. `wiki://exec/`. Combine with `scheme` if needed. */
  readonly uriPrefix?: string;
}

export interface McpToolClient {
  readResource(uri: string): Promise<string>;
  listResources(filter?: McpListFilter): Promise<readonly string[]>;
  /**
   * Optional: invoke an MCP tool by name (PR-O3, phase-a
   * appendix #7). Returns the parsed JSON-RPC `result`
   * (shape varies per tool). Backward-compatible — clients
   * targeting servers that only expose resources (e.g.
   * gitea-wiki-mcp-server) leave this undefined.
   */
  callTool?(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

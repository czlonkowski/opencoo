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
 * Two operations:
 *   - `readResource(uri)` — fetch one resource body. Unknown
 *     URIs throw `McpResourceNotFoundError` (validation class,
 *     mirroring the MCP "resource not accessible" wire shape).
 *   - `listResources(filter?)` — enumerate available URIs with
 *     optional scheme + uriPrefix filters. v0.1 callers
 *     (Surfacer-style "find all `wiki://` resources for this
 *     domain") use the prefix path; the unfiltered call mostly
 *     exists for testing.
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
}

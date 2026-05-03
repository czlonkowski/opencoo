/**
 * In-memory `McpToolClient` fixture. Pure data — does not import
 * or know anything about gitea-wiki-mcp-server's internals (per
 * Q12: gitea-mcp runs out-of-process; production wires
 * `HttpMcpToolClient` in PR 23+; tests don't need the network).
 *
 * Tests seed resources via `setResource` / `seedFromMap`, the
 * agent body calls `readResource` / `listResources` against the
 * port, unknown URIs throw `McpResourceNotFoundError`.
 *
 * PR-O3 (phase-a appendix #7) adds optional `callTool` support:
 * tests seed per-tool results via `setToolResult`, the body calls
 * `callTool(name, args?)`, and unknown tool names throw a
 * descriptive Error so the test setup gap is loud (no silent
 * undefined return).
 */
import { McpResourceNotFoundError } from "./errors.js";
import type { McpListFilter, McpToolClient } from "./interface.js";

export class InMemoryMcpToolClient implements McpToolClient {
  private readonly resources = new Map<string, string>();
  private readonly toolResults = new Map<string, unknown>();

  setResource(uri: string, body: string): void {
    this.resources.set(uri, body);
  }

  seedFromMap(entries: Readonly<Record<string, string>>): void {
    for (const [uri, body] of Object.entries(entries)) {
      this.resources.set(uri, body);
    }
  }

  /** PR-O3: seed the response for `callTool(name, ...)`. The
   *  in-memory fixture ignores the args argument — tests
   *  asserting on call args should mock at a different layer. */
  setToolResult(name: string, result: unknown): void {
    this.toolResults.set(name, result);
  }

  reset(): void {
    this.resources.clear();
    this.toolResults.clear();
  }

  async readResource(uri: string): Promise<string> {
    const body = this.resources.get(uri);
    if (body === undefined) {
      throw new McpResourceNotFoundError(uri);
    }
    return body;
  }

  async listResources(
    filter?: McpListFilter,
  ): Promise<readonly string[]> {
    const all = [...this.resources.keys()];
    if (filter === undefined) return all;
    return all.filter((uri) => {
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

  async callTool(
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _args?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.toolResults.has(name)) {
      throw new Error(
        `InMemoryMcpToolClient: no result seeded for tool '${name}' (call setToolResult before invoking)`,
      );
    }
    return this.toolResults.get(name);
  }
}

/**
 * In-memory `McpToolClient` fixture. Pure data — does not import
 * or know anything about gitea-wiki-mcp-server's internals (per
 * Q12: gitea-mcp runs out-of-process; production wires
 * `HttpMcpToolClient` in PR 23+; tests don't need the network).
 *
 * Tests seed resources via `setResource` / `seedFromMap`, the
 * agent body calls `readResource` / `listResources` against the
 * port, unknown URIs throw `McpResourceNotFoundError`.
 */
import { McpResourceNotFoundError } from "./errors.js";
import type { McpListFilter, McpToolClient } from "./interface.js";

export class InMemoryMcpToolClient implements McpToolClient {
  private readonly resources = new Map<string, string>();

  setResource(uri: string, body: string): void {
    this.resources.set(uri, body);
  }

  seedFromMap(entries: Readonly<Record<string, string>>): void {
    for (const [uri, body] of Object.entries(entries)) {
      this.resources.set(uri, body);
    }
  }

  reset(): void {
    this.resources.clear();
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
}

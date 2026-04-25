/**
 * `wiki.read_page` — fetch one wiki page from the
 * gitea-wiki-mcp-server via the McpToolClient port. The agent's
 * `ctx.callTool('wiki.read_page', () => wikiReadPage(client,
 * { domainSlug, path }))` wraps this with the deny-list +
 * tool-call ledger.
 *
 * URI shape mirrors the gitea-mcp resource template:
 * `wiki://{domainSlug}/{path}` with the path verbatim (no
 * leading slash).
 */
import type { McpToolClient } from "../../mcp-tool-client/index.js";

export interface WikiReadPageArgs {
  readonly domainSlug: string;
  readonly path: string;
}

export async function wikiReadPage(
  client: McpToolClient,
  args: WikiReadPageArgs,
): Promise<string> {
  const uri = `wiki://${args.domainSlug}/${args.path}`;
  return client.readResource(uri);
}

/**
 * `index.search` — list wiki paths under a domain (with an
 * optional path prefix). v0.1 has no full-text search; the agent
 * gets the index of available pages and uses
 * `wiki.read_page` to pull content for the ones it cares about.
 *
 * Returns deterministic, sorted, domain-relative paths (just the
 * `path` portion, not the full URI). The McpToolClient port's
 * `listResources({ uriPrefix })` does the heavy lifting; this
 * wrapper strips the URI prefix back off so the caller deals in
 * the same path shape it would pass to `wikiReadPage`.
 */
import type { McpToolClient } from "../../mcp-tool-client/index.js";

export interface IndexSearchArgs {
  readonly domainSlug: string;
  /** Optional further-narrowing path prefix INSIDE the domain
   *  (e.g. `team/`). Defaults to no further filter — every page
   *  in the domain. */
  readonly pathPrefix?: string;
}

export async function indexSearch(
  client: McpToolClient,
  args: IndexSearchArgs,
): Promise<readonly string[]> {
  const domainPrefix = `wiki://${args.domainSlug}/`;
  const uriPrefix =
    args.pathPrefix !== undefined
      ? `${domainPrefix}${args.pathPrefix}`
      : domainPrefix;
  const uris = await client.listResources({ uriPrefix });
  return uris
    .map((uri) => uri.slice(domainPrefix.length))
    .filter((path) => path.endsWith(".md"))
    .sort();
}

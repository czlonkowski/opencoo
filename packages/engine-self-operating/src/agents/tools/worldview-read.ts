/**
 * `worldview.read` — fetch the per-domain `worldview.md`
 * synthesis (or the `company` aggregator) via the McpToolClient
 * port. URI shape: `worldview://{domainSlug}` with the reserved
 * `company` slug for cross-domain aggregation (architecture §9).
 */
import type { McpToolClient } from "../../mcp-tool-client/index.js";

export interface WorldviewReadArgs {
  readonly domainSlug: string;
}

export async function worldviewRead(
  client: McpToolClient,
  args: WorldviewReadArgs,
): Promise<string> {
  const uri = `worldview://${args.domainSlug}`;
  return client.readResource(uri);
}

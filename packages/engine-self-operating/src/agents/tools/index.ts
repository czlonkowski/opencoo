/**
 * Tool wrappers for the v0.1 reader agents (Heartbeat + Lint).
 * Each wrapper is a thin adapter over the McpToolClient port —
 * the agent body invokes them via the harness's
 * `ctx.callTool(name, () => wrapper(...))` so the deny-list +
 * tool-call ledger fire on every call.
 *
 * v0.1 surface: read-only, three tools.
 *   - `wiki.read_page`   — wiki://{slug}/{path} → body
 *   - `worldview.read`   — worldview://{slug} → body
 *   - `index.search`     — list paths under a domain (optional
 *                          path prefix; deterministic ordering)
 *
 * Builder + Chat tools (write paths, mcp client.call_tool, etc.)
 * arrive in PR 20.5 / PR 21+ alongside the agents that need
 * them.
 */
export {
  wikiReadPage,
  type WikiReadPageArgs,
} from "./wiki-read.js";
export {
  worldviewRead,
  type WorldviewReadArgs,
} from "./worldview-read.js";
export {
  indexSearch,
  type IndexSearchArgs,
} from "./index-search.js";

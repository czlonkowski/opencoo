/**
 * gitea-wiki-mcp-server `/refresh-all` ping (phase-a appendix #12
 * PR-Z8, closes G10).
 *
 * After a domain is provisioned in Gitea via `provisionDomainRepo`
 * and the engine has seeded the initial wiki files, opencoo POSTs
 * the FULL set of active domains to the MCP server's `/refresh-all`
 * endpoint so the MCP server's in-memory `RepoRegistry` stays in
 * sync without a hand-maintained `REPOS` JSON in `.env`.
 *
 * Failure semantics: this helper is FIRE-AND-FORGET on the
 * domain-create path. A 5xx, network blip, or 401 from the MCP
 * server logs a warn but never bubbles into the domain-create
 * response. The operator can manually `curl /refresh-all` later
 * with the same payload; the registry is idempotent. This shape
 * is deliberate — a half-deployed engine (MCP server not yet up,
 * different secret rotation timeline, partner running mcp-server
 * out-of-process) MUST NOT block legitimate domain creation.
 *
 * Configuration:
 *   - `GITEA_WIKI_MCP_URL` (or its `_FILE` variant) — full base URL
 *     of the MCP server (e.g. `http://gitea-wiki-mcp:3000`). When
 *     unset, the helper logs `wiki_mcp_refresh.skipped` at debug
 *     and returns without dispatching. Partner deployments running
 *     the MCP server alongside the engine in the same compose
 *     network set this; bare-engine deployments (no MCP server)
 *     leave it unset.
 *   - `MCP_BEARER_TOKEN` (or its `_FILE` variant) — same bearer
 *     token the MCP server validates. Operators rotate this in
 *     lockstep across engine + MCP server; the engine reads ONLY
 *     the inline+_FILE shape.
 */
import type { Logger } from "@opencoo/shared/logger";

/** Single repo descriptor sent to `/refresh-all`. The MCP server
 *  parses `RepoEntrySchema` (slug, owner, name, default,
 *  access_tag?, aggregator?) — we mirror the shape with the
 *  fields opencoo's `domains` table can supply. `branch` is
 *  documented but ignored on the server side. */
export interface RefreshAllRepo {
  readonly slug: string;
  readonly owner: string;
  readonly name?: string;
  readonly default?: boolean;
  readonly aggregator?: boolean;
}

export interface WikiMcpRefreshConfig {
  /** Base URL (no trailing slash) of the gitea-wiki-mcp-server. */
  readonly baseUrl: string;
  /** Bearer token the MCP server validates against
   *  `MCP_BEARER_TOKEN`. */
  readonly bearerToken: string;
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
  /** @internal Test seam — abort timeout. Defaults to 3000ms. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Fire-and-forget `/refresh-all` ping. Returns a `Promise<void>`
 * that NEVER rejects — the helper resolves either way and logs
 * the outcome. The caller (domain-create handler) does not await
 * the result; the call is dispatched and forgotten so a slow MCP
 * server cannot stretch the 201 response time.
 *
 * The promise is returned anyway so tests can `await` it for
 * deterministic assertions; production composition simply lets
 * it run to completion in the background.
 */
export async function pingRefreshAll(
  config: WikiMcpRefreshConfig,
  repos: ReadonlyArray<RefreshAllRepo>,
  logger: Logger,
): Promise<void> {
  if (repos.length === 0) {
    logger.debug("wiki_mcp_refresh.skipped", { reason: "no_repos" });
    return;
  }

  const url = `${config.baseUrl.replace(/\/+$/, "")}/refresh-all`;
  const fetchFn = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.bearerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ repos }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn("wiki_mcp_refresh.failed", {
        status: res.status,
        repos: repos.map((r) => r.slug),
      });
      return;
    }
    logger.debug("wiki_mcp_refresh.ok", {
      repos: repos.map((r) => r.slug),
    });
  } catch (err) {
    // AbortError / network failure / DNS — all swallowed. The
    // operator can re-trigger with a manual curl; the registry
    // is idempotent on replace.
    logger.warn("wiki_mcp_refresh.error", {
      err: err instanceof Error ? err.name : "unknown",
      repos: repos.map((r) => r.slug),
    });
  }
}

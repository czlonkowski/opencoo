/**
 * `worldview://{slug}` and the reserved `worldview://company` MCP resource
 * (THREAT-MODEL §3.14). Every LLM sees the worldview as persistent grounding,
 * so we must not leak content a principal's Gitea PAT cannot itself see.
 *
 * Authorisation model:
 *   - Static-token principal (internal MCP_BEARER_TOKEN) has implicit
 *     full-scope — no live API call.
 *   - OAuth-principal (Gitea user access token) → every request calls
 *     `GiteaScopeChecker.check(token, owner, name)`; deny if it returns
 *     `allow:false` OR anything throws. 60 s LRU cache absorbs the N+1.
 *
 * Error uniformity: every deny path (unknown slug / missing file /
 * out-of-scope / no aggregator / missing authInfo) surfaces the same
 * `McpError(InvalidRequest, "resource not accessible")`. The distinguishing
 * reason is logged at debug level for the operator. Callers cannot use
 * the error shape to fingerprint existence vs. scope.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepoRegistry } from "../services/repo-registry.js";
import { UnknownRepoError } from "../services/repo-registry.js";
import type { GiteaScopeChecker } from "../services/scope-checker.js";

const UNIFORM_DENY_MESSAGE = "resource not accessible";

/** Deny-cause tags are operator-facing only — never surface in responses. */
type DenyReason =
  | "unknown_slug"
  | "missing_file"
  | "out_of_scope"
  | "no_aggregator"
  | "no_auth";

export interface WorldviewReaderDeps {
  readonly registry: RepoRegistry;
  readonly scopeChecker: GiteaScopeChecker;
  /** Optional operator-facing logger. Defaults to a no-op so unit tests
   *  don't spam stderr; production wiring passes through to the main logger. */
  readonly log?: (reason: DenyReason, detail: Record<string, unknown>) => void;
}

export type WorldviewReader = (
  uri: URL,
  extra: { readonly authInfo?: AuthInfo },
) => Promise<ReadResourceResult>;

/**
 * Factory returns a reader callable — kept pure (no McpServer dep) so it can
 * be unit-tested without standing up a full MCP session. `registerWorldviewResource`
 * is the thin wrapper that binds it to a server instance.
 */
export function createWorldviewReader(
  deps: WorldviewReaderDeps,
): WorldviewReader {
  const log = deps.log ?? (() => undefined);

  function deny(reason: DenyReason, detail: Record<string, unknown>): never {
    log(reason, detail);
    throw new McpError(ErrorCode.InvalidRequest, UNIFORM_DENY_MESSAGE);
  }

  return async function readWorldview(uri, extra) {
    const slug = extractSlug(uri);
    if (slug === null) {
      deny("unknown_slug", { uri: uri.href });
    }

    const authInfo = extra.authInfo;
    if (!authInfo) {
      deny("no_auth", { uri: uri.href });
    }

    // Resolve the repo entry (either the aggregator for `company`, or a
    // literal slug otherwise) before any scope check, so we know WHICH repo
    // to check. The scope check then happens against that resolved repo.
    const { entry, filePath } = resolveTarget(deps.registry, slug, deny);

    // Scope check — static principal bypasses, OAuth principal invokes the
    // Gitea API through the cached checker. No-auth would have already
    // denied above; the assertion keeps the type checker happy.
    const kind = readPrincipalKind(authInfo);
    if (kind === "gitea") {
      const { allow } = await deps.scopeChecker.check(
        authInfo.token,
        entry.owner,
        entry.name,
      );
      if (!allow) {
        deny("out_of_scope", {
          slug: entry.slug,
          owner: entry.owner,
          name: entry.name,
        });
      }
    }

    // Only now do we touch disk. Missing file = same uniform deny as
    // unknown-slug so the client cannot distinguish "repo not in REPOS"
    // from "repo present but no worldview.md".
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {
      deny("missing_file", { slug: entry.slug, filePath });
    }

    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text,
        },
      ],
    };
  };
}

/** Walk the registry to find the aggregator repo (at most one). */
function findAggregator(
  registry: RepoRegistry,
): { entry: ReturnType<RepoRegistry["list"]>[number]; repoPath: string } | null {
  for (const entry of registry.list()) {
    if (entry.aggregator) {
      return { entry, repoPath: registry.resolve(entry.slug).repoPath };
    }
  }
  return null;
}

/**
 * Resolve a slug to `(repo entry, absolute file path on disk)`. For the
 * reserved `company` slug we route to the aggregator's `company.md`; for
 * any other slug we route to `{repo}/worldview.md`. Deny uniformly on
 * unknown-slug or no-aggregator.
 */
function resolveTarget(
  registry: RepoRegistry,
  slug: string,
  deny: (reason: DenyReason, detail: Record<string, unknown>) => never,
): { entry: ReturnType<RepoRegistry["list"]>[number]; filePath: string } {
  if (slug === "company") {
    const agg = findAggregator(registry);
    if (!agg) {
      deny("no_aggregator", { slug });
    }
    return {
      entry: agg.entry,
      filePath: path.join(agg.repoPath, "company.md"),
    };
  }

  try {
    const resolved = registry.resolve(slug);
    return {
      entry: resolved.entry,
      filePath: path.join(resolved.repoPath, "worldview.md"),
    };
  } catch (err) {
    if (err instanceof UnknownRepoError) {
      deny("unknown_slug", { slug });
    }
    throw err;
  }
}

/**
 * URLs with `worldview://` as the scheme put the slug in `url.hostname`
 * (because the `//` signals an authority component). Reject anything with
 * a path, query, or non-empty other components — we keep the surface tight
 * so future path-scoped worldviews don't accidentally silently work.
 */
function extractSlug(uri: URL): string | null {
  if (uri.protocol !== "worldview:") return null;
  // WHATWG URL lowercases hostname for non-special schemes too; slugs are
  // already lowercase by config validation so this is a no-op for valid
  // input and normalises capitalised callers to the canonical form.
  const slug = uri.hostname;
  if (!slug) return null;
  if (uri.pathname && uri.pathname !== "" && uri.pathname !== "/") return null;
  return slug;
}

function readPrincipalKind(authInfo: AuthInfo): "static" | "gitea" | "unknown" {
  const extra = authInfo.extra;
  if (extra && typeof extra === "object" && "kind" in extra) {
    const kind = (extra as { kind?: unknown }).kind;
    if (kind === "static" || kind === "gitea") return kind;
  }
  return "unknown";
}

/**
 * Bind the reader to an McpServer. Called from `createServer`. The SDK
 * hands us a `{uri, variables, extra}` triple for template callbacks;
 * `extra.authInfo` is the value the transport pulled off `req.auth`.
 */
export function registerWorldviewResource(
  server: McpServer,
  registry: RepoRegistry,
  scopeChecker: GiteaScopeChecker,
  log?: WorldviewReaderDeps["log"],
): void {
  const reader = createWorldviewReader(
    log !== undefined
      ? { registry, scopeChecker, log }
      : { registry, scopeChecker },
  );
  server.registerResource(
    "worldview",
    new ResourceTemplate("worldview://{slug}", { list: undefined }),
    {
      title: "Domain Worldview",
      description:
        "Thinker-compiled synthesis for a knowledge domain. URI `worldview://{slug}` returns that domain's worldview.md. The reserved `worldview://company` URI returns the aggregator's company.md (when configured). Per-request Gitea PAT scope check is enforced for OAuth principals; internal static-token clients get implicit full scope.",
      mimeType: "text/markdown",
    },
    async (uri, _variables, extra) => {
      return reader(uri, { authInfo: extra.authInfo });
    },
  );
}

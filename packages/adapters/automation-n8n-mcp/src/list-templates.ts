/**
 * `listAvailableTemplateSlugs` — boot-time fetch of the closed list
 * of n8n template slugs the Surfacer LLM is allowed to propose
 * (PR-O3, phase-a appendix #7).
 *
 * Calls the n8n-mcp MCP server's `search_templates` tool in
 * `patterns` mode (lightweight workflow pattern summaries mined
 * from 2,700+ templates; recommended for boot-time enumeration).
 *
 * # Boot-tolerance
 *
 * Returns the vendored `builderSkills.map(s => s.slug)` fallback
 * unchanged when ANY of the following holds:
 *   - mcp client is null (env vars unset)
 *   - mcp client lacks `callTool` (older transport)
 *   - callTool throws (network failure, JSON-RPC error, timeout)
 *   - response shape doesn't parse to a non-empty slug array
 *
 * Surfacer remains REGISTERED in either case (per round-2 fix #2
 * of PR-N3) — the omission-on-empty-catalog path is reserved for
 * the corner case where the operator explicitly passes an empty
 * fallback array AND n8n-mcp is unavailable.
 *
 * # v0.1 scope
 *
 * Boot-time only. If templates change at runtime, the operator
 * restarts the engine. Live-cache invalidation defers to v0.2 once
 * partner deployments have scaled-deployment friction.
 *
 * # Boundary
 *
 * This module deliberately accepts a structural `McpToolCallClient`
 * type rather than importing `McpToolClient` from
 * `@opencoo/engine-self-operating`. The adapter package mirrors the
 * `N8nLikeApi` pattern in `n8n-api.ts` — engine ports are described
 * locally, the production `HttpMcpToolClient` from
 * engine-self-operating satisfies the shape structurally at the
 * composition root in `production-composition.ts`.
 */
import type { Logger } from "@opencoo/shared/logger";
import { scrubPat } from "@opencoo/shared/scrub";

/** Bound on the response size — an n8n-mcp deployment in the wild
 *  has ~2,700 templates, and we don't want a runaway response
 *  blowing up the Surfacer system prompt or the boot log. The
 *  `patterns` mode aggregates templates into ~10 categories so
 *  100 is comfortably above the expected upper bound. */
const N8N_MCP_TEMPLATES_LIMIT = 100;

/** Cap applied to scrubbed error strings before logging — same
 *  200-char cap the rest of the codebase uses for THREAT-MODEL
 *  §3.6 invariant 11 compliance. */
const ERROR_MESSAGE_MAX_LENGTH = 200;

/** Local structural mirror of the engine-side `McpToolClient`
 *  port — only the `callTool` operation is exercised here. The
 *  production `HttpMcpToolClient` satisfies this structurally;
 *  test stubs implement it directly. */
export interface McpToolCallClient {
  callTool?(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

export interface ListAvailableTemplateSlugsArgs {
  /** The n8n-mcp client (a `HttpMcpToolClient` pointed at the
   *  n8n-mcp server URL — distinct from the gitea-wiki-mcp
   *  client). `null` when N8N_MCP_BASE_URL / N8N_MCP_BEARER_TOKEN
   *  env vars are unset. */
  readonly mcp: McpToolCallClient | null;
  /** Vendored baseline — typically `builderSkills.map(s => s.slug)`
   *  from `./builder-skills.js`. Used when n8n-mcp is unreachable
   *  so Surfacer remains registered. */
  readonly fallbackSlugs: readonly string[];
  /** Logger handle for the boot-time warn lines. */
  readonly logger: Logger;
}

export async function listAvailableTemplateSlugs(
  args: ListAvailableTemplateSlugsArgs,
): Promise<readonly string[]> {
  // No client configured — return fallback verbatim. The orchestrator
  // already logged `n8n_mcp.unavailable` upstream so we don't double-log.
  if (args.mcp === null || typeof args.mcp.callTool !== "function") {
    return args.fallbackSlugs;
  }

  let raw: unknown;
  try {
    raw = await args.mcp.callTool("search_templates", {
      searchMode: "patterns",
      limit: N8N_MCP_TEMPLATES_LIMIT,
    });
  } catch (err) {
    args.logger.warn("surfacer.template_catalog_n8n_mcp_unreachable", {
      error: safeError(err),
      fallback_count: args.fallbackSlugs.length,
    });
    return args.fallbackSlugs;
  }

  const slugs = parseSlugs(raw);
  if (slugs.length === 0) {
    args.logger.warn("surfacer.template_catalog_n8n_mcp_empty", {
      reason: "search_templates returned 0 parseable slugs",
      fallback_count: args.fallbackSlugs.length,
    });
    return args.fallbackSlugs;
  }
  return [...new Set(slugs)].sort();
}

function safeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return scrubPat(raw).slice(0, ERROR_MESSAGE_MAX_LENGTH);
}

/** Defensively walk the n8n-mcp response and extract a string-array
 *  of slugs. Accepts two known shapes:
 *
 *    1. `patterns` mode (current — verified against
 *       n8n-mcp@latest 2026-05-02): the JSON-RPC `result` is
 *       `{ content: [{ type: "text", text: <jsonString> }] }`
 *       where jsonString parses to
 *       `{ categories: [{ category: "ai_automation", ... }, ...] }`.
 *       Each `category` field is a stable identifier the Surfacer
 *       LLM uses as the slug for "this class of automation."
 *
 *    2. A future `items[]`-with-per-template-`slug` shape — if
 *       n8n-mcp ever returns true template slugs (e.g. via
 *       `keyword` or a `slugs` mode), the parser walks
 *       `items[].slug` as a secondary path.
 *
 *  Anything else returns `[]` so the caller's "empty → fallback"
 *  branch fires. The function MUST NOT throw — every parse failure
 *  is silent + falls back. */
function parseSlugs(raw: unknown): readonly string[] {
  if (raw === null || typeof raw !== "object") return [];

  // MCP tools/call envelope: { content: [{ type: "text", text: <json> }, ...] }
  const envelope = raw as { content?: unknown };
  if (!Array.isArray(envelope.content)) return [];

  const slugs: string[] = [];
  for (const part of envelope.content) {
    if (part === null || typeof part !== "object") continue;
    const p = part as { type?: unknown; text?: unknown };
    if (p.type !== "text" || typeof p.text !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(p.text);
    } catch {
      continue;
    }
    extractSlugsInto(parsed, slugs);
  }
  return slugs;
}

/** Walk a parsed JSON value looking for slug-bearing shapes. Pushes
 *  every found slug into `out`. */
function extractSlugsInto(parsed: unknown, out: string[]): void {
  if (parsed === null || typeof parsed !== "object") return;

  const obj = parsed as {
    categories?: unknown;
    items?: unknown;
    slugs?: unknown;
  };

  // Shape 1: { categories: [{ category: "..." }, ...] } — the
  // current n8n-mcp `patterns` mode.
  if (Array.isArray(obj.categories)) {
    for (const c of obj.categories) {
      if (c === null || typeof c !== "object") continue;
      const category = (c as { category?: unknown }).category;
      if (typeof category === "string" && category.length > 0) {
        out.push(category);
      }
    }
  }

  // Shape 2: { items: [{ slug: "..." }, ...] } — a future
  // per-template-slug shape.
  if (Array.isArray(obj.items)) {
    for (const it of obj.items) {
      if (it === null || typeof it !== "object") continue;
      const slug = (it as { slug?: unknown }).slug;
      if (typeof slug === "string" && slug.length > 0) {
        out.push(slug);
      }
    }
  }

  // Shape 3: { slugs: ["a", "b", ...] } — a hypothetical flat shape.
  if (Array.isArray(obj.slugs)) {
    for (const s of obj.slugs) {
      if (typeof s === "string" && s.length > 0) {
        out.push(s);
      }
    }
  }
}

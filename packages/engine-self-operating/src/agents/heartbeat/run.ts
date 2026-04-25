/**
 * Heartbeat body — read worldview + page index, ask the LLM for
 * the briefing, return the schema-validated JSON output.
 *
 * The body is purely read-only. No wikiWrite, no MCP write
 * tool, no `output_channel_deliver` tool — the engine's post-
 * run hook handles delivery via OutputChannelRegistry (Q10).
 *
 * Tool calls flow through `ctx.callTool(name, () => ...)` so
 * the deny-list + tool-call ledger fire on every call. The
 * spotlighted memory the harness already prepared
 * (`ctx.spotlightedMemory`) is concatenated into the prompt;
 * worldview + index entries fetched in this body are
 * additionally spotlighted before reaching the LLM.
 */
import { spotlight } from "@opencoo/shared/spotlight";
import { loadPrompt } from "@opencoo/shared/prompts";
import type { DomainId } from "@opencoo/shared/db";

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { AgentRunContext } from "../../agent-harness/index.js";
import type { McpToolClient } from "../../mcp-tool-client/index.js";
import { assertDomainSlugInScope } from "../scope-check.js";
import {
  indexSearch,
  worldviewRead,
} from "../tools/index.js";

import {
  HEARTBEAT_OUTPUT_SCHEMA,
  type HeartbeatOutput,
} from "./types.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface RunHeartbeatArgs {
  /** Postgres handle — used for the domainSlug × scopeDomainIds
   *  cross-check at run-time entry. */
  readonly db: Db;
  readonly mcp: McpToolClient;
  /** Wiki/MCP slug for the domain whose worldview + index this
   *  briefing summarises. The body resolves slug → id via the
   *  database and asserts the id is in the instance's
   *  scopeDomainIds before doing any further work — a slug
   *  outside scope throws DomainScopeMismatchError (DLQ). */
  readonly domainSlug: string;
  /** Optional clock for deterministic test fetched-at metadata. */
  readonly now?: () => Date;
}

export async function runHeartbeat(
  ctx: AgentRunContext,
  args: RunHeartbeatArgs,
): Promise<HeartbeatOutput> {
  const now = args.now ?? ((): Date => new Date());

  const scope = ctx.instance.scopeDomainIds;
  if (scope.length === 0) {
    // Caller (engine wiring) is responsible for refusing to
    // schedule a Heartbeat on an instance with empty scope —
    // surface as an explicit error rather than silently
    // routing against a zero-width policy.
    throw new Error(
      `heartbeat: instance ${ctx.instance.id} has empty scopeDomainIds — nothing to summarise`,
    );
  }

  // Cross-check: domainSlug must resolve to an id in scope
  // BEFORE any LLM call or MCP read. Throws
  // DomainScopeMismatchError (validation → DLQ) on mismatch
  // or unknown slug.
  const resolvedDomainId = await assertDomainSlugInScope({
    db: args.db,
    domainSlug: args.domainSlug,
    scopeDomainIds: scope,
  });
  const domainId = resolvedDomainId as DomainId;

  // Tool call 1: read the per-domain worldview synthesis.
  const worldviewBody = await ctx.callTool("worldview.read", () =>
    worldviewRead(args.mcp, { domainSlug: args.domainSlug }),
  );

  // Tool call 2: enumerate the domain's page index. Heartbeat
  // doesn't read every page — the LLM uses the path list to
  // pick what to mention; PR 20.5 Chat agent reads on demand.
  const pagePaths = await ctx.callTool("index.search", () =>
    indexSearch(args.mcp, { domainSlug: args.domainSlug }),
  );

  const prompt = loadPrompt({ name: "heartbeat", locale: ctx.instance.locale });

  // Spotlight the fetched-at-runtime context. The harness has
  // already spotlighted `ctx.spotlightedMemory` (prior runs);
  // we add the worldview + page index here, each in its own
  // <source_content> envelope.
  const fetchedAt = now();
  const worldviewEnvelope = spotlight({
    content: worldviewBody,
    source: `worldview://${args.domainSlug}`,
    fetchedAt,
  });
  const indexEnvelope = spotlight({
    content: pagePaths.join("\n"),
    source: `index://${args.domainSlug}`,
    fetchedAt,
  });

  const memoryBlock =
    ctx.spotlightedMemory.length === 0
      ? ""
      : `\n\n# Prior briefings (your memory)\n${ctx.spotlightedMemory.join("\n\n")}`;

  const fullPrompt = `${prompt.body}\n\n# Domain worldview\n${worldviewEnvelope}\n\n# Available wiki pages\n${indexEnvelope}${memoryBlock}`;

  const result = await ctx.router.generateObject({
    domainId,
    tier: "thinker",
    pipelineOrAgent: "heartbeat",
    prompt: fullPrompt,
    schema: HEARTBEAT_OUTPUT_SCHEMA,
  });

  return result.object;
}

/**
 * Activity tab — agent runs routes (phase-a appendix #4 PR-B).
 *
 * `GET /api/admin/agent-runs`
 *   Paginated reverse-chrono list of agent runs. Does NOT include the
 *   `output` field — that's detail-only.
 *   Query params: `limit` (default 50, max 200), `offset` (default 0).
 *
 * `GET /api/admin/agent-runs/:id`
 *   Single run with full fields including `toolCalls`, `skillsUsed`.
 *   `output` is gated by `LLM_DEBUG_LOG=1` (THREAT-MODEL §2 invariant 11):
 *   when the gate is off, `output` is returned as `null`.
 *
 * Both routes are read-only (GET). No state-changing endpoints here per
 * THREAT-MODEL §2 invariant 8 (append-only tables).
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface RegisterAgentRunsRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
  /** Whether `LLM_DEBUG_LOG=1` is set. Controls whether `output` field
   *  is included in the detail response. THREAT-MODEL §2 invariant 11. */
  readonly llmDebugLog: boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function registerAgentRunsRoutes(
  args: RegisterAgentRunsRoutesArgs,
): void {
  // ── List ──────────────────────────────────────────────────────────────
  args.app.get("/api/admin/agent-runs", async (req) => {
    const query = req.query as Record<string, string | undefined>;
    const rawLimit = query["limit"] !== undefined ? parseInt(query["limit"], 10) : DEFAULT_LIMIT;
    const rawOffset = query["offset"] !== undefined ? parseInt(query["offset"], 10) : 0;

    const limit = Math.min(isNaN(rawLimit) ? DEFAULT_LIMIT : rawLimit, MAX_LIMIT);
    const offset = isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

    const [rowsResult, countResult] = await Promise.all([
      args.db.execute(sql`
        SELECT
          id::text                AS id,
          definition_slug         AS "definitionSlug",
          instance_id::text       AS "instanceId",
          trigger::text           AS trigger,
          skills_used             AS "skillsUsed",
          tokens_in               AS "tokensIn",
          tokens_out              AS "tokensOut",
          cost_usd::text          AS "costUsd",
          latency_ms              AS "latencyMs",
          status::text            AS status,
          error_class::text       AS "errorClass",
          started_at              AS "startedAt",
          ended_at                AS "endedAt",
          created_at              AS "createdAt"
        FROM agent_runs
        ORDER BY started_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `) as unknown as {
        rows: Array<Record<string, unknown>>;
      },
      args.db.execute(sql`
        SELECT COUNT(*)::int AS total FROM agent_runs
      `) as unknown as {
        rows: Array<{ total: number }>;
      },
    ]);

    const total = countResult.rows[0]?.total ?? 0;
    const rows = rowsResult.rows.map(serializeRunListRow);
    return { rows, total };
  });

  // ── Detail ────────────────────────────────────────────────────────────
  args.app.get("/api/admin/agent-runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };

    const result = (await args.db.execute(sql`
      SELECT
        id::text                AS id,
        definition_slug         AS "definitionSlug",
        instance_id::text       AS "instanceId",
        trigger::text           AS trigger,
        inputs                  AS inputs,
        tool_calls              AS "toolCalls",
        output                  AS output,
        skills_used             AS "skillsUsed",
        tokens_in               AS "tokensIn",
        tokens_out              AS "tokensOut",
        cost_usd::text          AS "costUsd",
        latency_ms              AS "latencyMs",
        status::text            AS status,
        error_class::text       AS "errorClass",
        started_at              AS "startedAt",
        ended_at                AS "endedAt",
        created_at              AS "createdAt"
      FROM agent_runs
      WHERE id = ${id}::uuid
      LIMIT 1
    `)) as unknown as {
      rows: Array<Record<string, unknown>>;
    };

    const row = result.rows[0];
    if (row === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }

    return serializeRunDetailRow(row, args.llmDebugLog);
  });
}

/** Serialize a list-level row. Does NOT include `output`. */
function serializeRunListRow(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r["id"],
    definitionSlug: r["definitionSlug"],
    instanceId: r["instanceId"] ?? null,
    trigger: r["trigger"],
    skillsUsed: r["skillsUsed"] ?? [],
    tokensIn: r["tokensIn"] ?? 0,
    tokensOut: r["tokensOut"] ?? 0,
    costUsd: r["costUsd"] ?? "0",
    latencyMs: r["latencyMs"] ?? 0,
    status: r["status"],
    errorClass: r["errorClass"] ?? null,
    startedAt: toIso(r["startedAt"] as Date | string | null),
    endedAt: toIso(r["endedAt"] as Date | string | null),
    createdAt: toIso(r["createdAt"] as Date | string | null),
  };
}

/** Serialize a detail-level row. Gates `output` behind `llmDebugLog`. */
function serializeRunDetailRow(
  r: Record<string, unknown>,
  llmDebugLog: boolean,
): Record<string, unknown> {
  return {
    id: r["id"],
    definitionSlug: r["definitionSlug"],
    instanceId: r["instanceId"] ?? null,
    trigger: r["trigger"],
    inputs: r["inputs"] ?? {},
    toolCalls: r["toolCalls"] ?? [],
    // THREAT-MODEL §2 invariant 11: output gated behind LLM_DEBUG_LOG.
    output: llmDebugLog ? (r["output"] ?? null) : null,
    skillsUsed: r["skillsUsed"] ?? [],
    tokensIn: r["tokensIn"] ?? 0,
    tokensOut: r["tokensOut"] ?? 0,
    costUsd: r["costUsd"] ?? "0",
    latencyMs: r["latencyMs"] ?? 0,
    status: r["status"],
    errorClass: r["errorClass"] ?? null,
    startedAt: toIso(r["startedAt"] as Date | string | null),
    endedAt: toIso(r["endedAt"] as Date | string | null),
    createdAt: toIso(r["createdAt"] as Date | string | null),
  };
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value as string);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

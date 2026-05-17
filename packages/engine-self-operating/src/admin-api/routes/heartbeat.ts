/**
 * `GET /api/admin/heartbeat` — latest Heartbeat agent run output per domain.
 *
 * Phase-a appendix #4 PR-D.
 *
 * Returns the latest `agent_runs.output` per `instance_id` group for
 * `definition_slug='heartbeat'` runs that have a non-null output
 * (i.e. completed runs only).
 *
 * IMPORTANT: this endpoint reads agent_runs.output directly — the same
 * HeartbeatOutput object that the OutputAdapter delivers. No LLM re-call
 * is made. (THREAT-MODEL §2 invariant 11 is satisfied because we are reading
 * already-stored output, not logging prompts; the output field itself is
 * the structured JSON artifact, not raw LLM text.)
 *
 * Response shape per report:
 *   - runId: string (UUID) — deep-link into /api/admin/agent-runs/:id
 *   - instanceId: string | null
 *   - instanceName: string | null — resolved from agent_instances.name
 *   - startedAt: string | null
 *   - output: HeartbeatOutput (version, summary, alerts[])
 *
 * Append-only — GET only, no state mutations.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface RegisterHeartbeatRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
}

export function registerHeartbeatRoutes(
  args: RegisterHeartbeatRoutesArgs,
): void {
  // ── PR-W8 (phase-a appendix #15) — diagnostic preconditions ─────────────
  //
  // Powers the Reports tab's empty-state panel. When the heartbeat list
  // renders empty, the panel asks the server WHY: is there no heartbeat
  // instance? Is one configured but disabled? Bound without channels?
  // Has it never run? Did the most recent run land with `output IS NULL`?
  //
  // Read-only, admin-team gated like the rest of this file. Returns counts
  // + a single "mostRecentRun" summary; no run output, no body bytes, so
  // the response is safe to expose without further scrubbing.
  args.app.get("/api/admin/heartbeat/preconditions", async () => {
    // 1. Heartbeat instance counts (total / enabled / channel-less).
    //    `output_channel_ids` is jsonb '[]' when empty; jsonb_array_length
    //    is the cheapest way to discriminate without parsing client-side.
    //    `instances_without_output_channels` is scoped to ENABLED instances
    //    only — a disabled instance is surfaced one tier above (the panel
    //    walks the chain in order and the disabled state wins), so
    //    double-counting it as channel-less would muddy the diagnostic.
    const countsResult = (await args.db.execute(sql`
      SELECT
        COUNT(*)::int AS "totalCount",
        COUNT(*) FILTER (WHERE enabled = true)::int AS "enabledCount",
        COUNT(*) FILTER (
          WHERE enabled = true
            AND jsonb_array_length(output_channel_ids) = 0
        )::int AS "channelLessCount"
      FROM agent_instances
      WHERE definition_slug = 'heartbeat'
    `)) as unknown as {
      rows: Array<Record<string, unknown>>;
    };
    const countsRow = countsResult.rows[0] ?? {};

    // 2. Most recent heartbeat run — any status, output may be null.
    //    LEFT JOIN agent_instances so the row survives when the instance
    //    has been hard-deleted (defense-in-depth; the production schema
    //    has ON DELETE RESTRICT, but the diagnostic must not crash on
    //    a missing instance row).
    const runResult = (await args.db.execute(sql`
      SELECT
        ar.started_at         AS "startedAt",
        ar.status::text       AS status,
        (ar.output IS NULL)   AS "outputIsNull",
        ai.name               AS "instanceName"
      FROM agent_runs ar
      LEFT JOIN agent_instances ai ON ai.id = ar.instance_id
      WHERE ar.definition_slug = 'heartbeat'
      ORDER BY ar.started_at DESC
      LIMIT 1
    `)) as unknown as {
      rows: Array<Record<string, unknown>>;
    };
    const runRow = runResult.rows[0];

    const mostRecentRun = runRow === undefined
      ? null
      : {
          startedAt: toIso(runRow["startedAt"] as Date | string | null),
          status: (runRow["status"] as string | null) ?? "unknown",
          outputIsNull: runRow["outputIsNull"] === true,
          instanceName: (runRow["instanceName"] as string | null) ?? null,
        };

    // `mostRecentDispatchedAt` and `mostRecentRun.startedAt` come from
    // the same `started_at` column today. They are surfaced separately
    // so a future change (e.g. distinguishing enqueue-time from
    // run-start-time) can refine the dispatch timestamp without
    // breaking the Reports panel's "most recent run" widget.
    return {
      heartbeatInstanceCount:
        (countsRow["totalCount"] as number | null) ?? 0,
      enabledHeartbeatInstanceCount:
        (countsRow["enabledCount"] as number | null) ?? 0,
      instancesWithoutOutputChannels:
        (countsRow["channelLessCount"] as number | null) ?? 0,
      mostRecentRun,
      mostRecentDispatchedAt:
        mostRecentRun !== null ? mostRecentRun.startedAt : null,
    };
  });

  args.app.get("/api/admin/heartbeat", async () => {
    // Fetch the latest completed heartbeat run per instance_id group.
    // NULL instance_id is treated as its own group (no-instance runs).
    // Only rows with non-null output are returned (running/failed excluded).
    // Inner query: pick the latest completed run per instance_id group.
    // Outer query: order groups by recency so the most recently active
    // instance appears first in the response.
    const result = (await args.db.execute(sql`
      SELECT *
      FROM (
        SELECT DISTINCT ON (ar.instance_id)
          ar.id::text           AS "runId",
          ar.instance_id::text  AS "instanceId",
          ai.name               AS "instanceName",
          ar.started_at         AS "startedAt",
          ar.output             AS output
        FROM agent_runs ar
        LEFT JOIN agent_instances ai ON ai.id = ar.instance_id
        WHERE ar.definition_slug = 'heartbeat'
          AND ar.output IS NOT NULL
        ORDER BY ar.instance_id, ar.started_at DESC
      ) latest
      ORDER BY "startedAt" DESC
    `)) as unknown as {
      rows: Array<Record<string, unknown>>;
    };

    const reports = result.rows.map((r) => ({
      runId: r["runId"] as string,
      instanceId: (r["instanceId"] as string | null) ?? null,
      instanceName: (r["instanceName"] as string | null) ?? null,
      startedAt: toIso(r["startedAt"] as Date | string | null),
      output: r["output"] as unknown,
    }));

    return { reports };
  });
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Scheduler tab — listing + cadence editor for every recurring
 * agent dispatch the in-process scheduler currently has registered
 * (PR-M2 + PR-R6, phase-a appendix #5/#10).
 *
 * `GET /api/admin/scheduler`
 *   Returns a flat `{ schedules: [...] }` snapshot with
 *   `instanceId`, `definitionSlug`, `name`, `scheduleCron`,
 *   `nextFireAt` (computed via `cron-parser`), and `lastFireAt`
 *   (most recent `agent_runs.started_at` for the instance, or
 *   `null` if the instance has never fired).
 *
 * `PUT /api/admin/scheduler/:agent`  (PR-R6)
 *   Body: `{ cron: string }`. Flips the cron pattern for every
 *   `agent_instances` row whose `definition_slug` matches `:agent`,
 *   inside ONE DB transaction. The dispatcher's BullMQ remove +
 *   add pair runs from inside the transaction so a partial swap
 *   rolls back the SQL UPDATE — the operator never observes a
 *   half-applied state. Audit row written BEFORE the side-effect
 *   pair (audit-before-side-effect, mirrors PR-R3). Response carries
 *   the next 5 fires for the new pattern so the UI can confirm.
 *
 * The route reads the schedule snapshot from an injected
 * `SchedulerSource` (the production wiring passes the
 * AgentDispatcher); this keeps the route handler decoupled from
 * the dispatcher class for testability and to satisfy the
 * `no-cross-engine-import` lint rule (the route lives in
 * engine-self-operating, the dispatcher does too — no boundary
 * crossing here, but the source-injection pattern keeps the
 * surface narrow). The cadence-update verb takes a separately-
 * injected `SchedulerUpdate` callable so tests can stub the
 * BullMQ swap without round-tripping through ioredis-mock.
 *
 * Auth is handled by the `verifyAdmin` wrapper that
 * `registerAdminApi` applies at registration time — this file
 * does not gate auth itself; the PUT verb additionally registers
 * `requireCsrf` as a preHandler.
 */
import cronParser from "cron-parser";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { safeErrorMessage } from "@opencoo/shared/scrub";

import { writeAuditLog } from "../audit-log.js";
import { requireAdminContext } from "../auth.js";
import { requireCsrf } from "../csrf.js";

import { nextFireAt, validateCron } from "../../scheduler/cron-validate.js";
import type { RegisteredSchedule } from "../../scheduler/agent-dispatcher.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Narrow surface the route reads from. The production wiring
 *  passes the AgentDispatcher (which exposes `listSchedules()`);
 *  tests inject a literal stub. */
export interface SchedulerSource {
  listSchedules(): readonly RegisteredSchedule[];
}

/** Narrow callable the PUT verb invokes to swap each instance's
 *  BullMQ repeatable. Production passes
 *  `dispatcher.updateSchedule.bind(dispatcher)`; tests inject a
 *  stub that records calls (and may throw to exercise rollback). */
export interface SchedulerUpdate {
  (args: {
    readonly entries: ReadonlyArray<{
      readonly instanceId: string;
      readonly definitionSlug: string;
      readonly name: string;
      readonly oldCron: string;
      readonly newCron: string;
    }>;
  }): Promise<void>;
}

/** Allowed agent slugs for the cadence editor. Mirrors the closed
 *  set in `agents-dispatch.ts:DISPATCHABLE_AGENT_SLUGS` — the four
 *  schedulable v0.1 agents. Adding a slug here MUST be paired with
 *  a registered runner in the production `AgentRunnerRegistry`. */
const SCHEDULER_EDITABLE_SLUGS = [
  "heartbeat",
  "lint",
  "surfacer",
  "builder",
] as const;

type SchedulerEditableSlug = (typeof SCHEDULER_EDITABLE_SLUGS)[number];

/** Body of `PUT /api/admin/scheduler/:agent`. Strict schema rejects
 *  unknown keys so an attacker-supplied body can't smuggle freeform
 *  text into the audit metadata (THREAT-MODEL §3.13). The cron
 *  string is bounded — a 5-field cron pattern fits comfortably in
 *  120 bytes; rejecting longer values keeps the row size predictable
 *  AND makes the `cron-parser` parse step bounded too. */
const updateBodySchema = z
  .object({
    cron: z.string().min(1).max(120),
  })
  .strict();

/** Number of upcoming fires the response carries so the UI can
 *  confirm the cadence change matches the operator's intent. Five
 *  is enough for the common "weekly / bi-weekly" eyeball check;
 *  more would inflate the response without adding signal. */
const NEXT_FIRES_PREVIEW_COUNT = 5;

export interface RegisterSchedulerRouteArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
  readonly source: SchedulerSource;
  /** PR-R6 — optional cadence-update callable. Production passes
   *  `dispatcher.updateSchedule.bind(dispatcher)`. When undefined
   *  the PUT verb registers but every call returns 503 (composition
   *  incomplete — same boot-tolerance pattern as PR-R3). */
  readonly updateSchedule?: SchedulerUpdate;
  /** Optional clock seam for deterministic nextFireAt tests. */
  readonly now?: () => Date;
}

interface AgentRunStartedRow {
  readonly instance_id: string;
  readonly started_at: Date | string | null;
}

interface InstanceDomainRow {
  readonly instance_id: string;
  readonly domain_slug: string | null;
}

export function registerSchedulerRoute(
  args: RegisterSchedulerRouteArgs,
): void {
  const now = args.now ?? ((): Date => new Date());
  args.app.get("/api/admin/scheduler", async () => {
    const schedules = args.source.listSchedules();
    if (schedules.length === 0) {
      return { schedules: [] };
    }
    const instanceIds = schedules.map((s) => s.instanceId);
    // PR-R3 — load per-instance domain slugs so the management UI
    // can wire the "Run now" buttons without a separate fetch per
    // instance. Resolved from the FIRST entry in
    // `agent_instances.scope_domain_ids` (v0.1 single-domain
    // pilots have exactly one entry; multi-domain scope expansion
    // is a v0.2 concern — same precedent as `agent-runners.ts`).
    const [lastFireMap, domainSlugMap] = await Promise.all([
      loadLastFireMap(args.db, instanceIds),
      loadDomainSlugMap(args.db, instanceIds),
    ]);
    const fromTs = now();
    const enriched = schedules.map((s) => ({
      instanceId: s.instanceId,
      definitionSlug: s.definitionSlug,
      name: s.name,
      scheduleCron: s.scheduleCron,
      nextFireAt: toIso(nextFireAt(s.scheduleCron, fromTs)),
      lastFireAt: toIso(lastFireMap.get(s.instanceId) ?? null),
      domainSlug: domainSlugMap.get(s.instanceId) ?? null,
    }));
    return { schedules: enriched };
  });

  // PR-R6 — cadence editor. Validates the cron string via
  // cron-parser BEFORE any side effect; on a valid pattern, runs
  // the audit-log INSERT + the agent_instances.schedule_cron
  // UPDATE + the dispatcher's BullMQ remove+add pair inside ONE
  // DB transaction. A throw at the BullMQ step rolls the SQL
  // UPDATE back so the operator never observes a half-applied
  // state (DB cron column out of sync with the registered
  // repeatable). The audit row is INSIDE the transaction too so
  // a rollback erases the audit attempt — the operator's trail
  // matches the actual on-disk effect, mirroring source-bindings'
  // delete pattern (PR-Q10b precedent).
  args.app.put(
    "/api/admin/scheduler/:agent",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);

      // 1. Validate the URL slug against the closed editable set.
      const rawSlug = (req.params as { agent: string }).agent;
      if (!isEditableSlug(rawSlug)) {
        return reply.code(404).send({
          error: "agent_slug_unknown",
          slug: rawSlug,
        });
      }
      const agentSlug: SchedulerEditableSlug = rawSlug;

      // 2. Validate the body shape.
      const parsed = updateBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: "validation_failed",
          issues: parsed.error.issues,
        });
      }
      const newCron = parsed.data.cron;

      // 3. Validate the cron pattern BEFORE any side effect. A
      //    422 here means the route never wrote the audit row,
      //    never touched the DB, never paged the BullMQ index —
      //    cleanest possible failure surface for a malformed
      //    pattern.
      const cronCheck = validateCron(newCron);
      if (!cronCheck.valid) {
        return reply.code(422).send({
          error: "cron_invalid",
          reason: cronCheck.error ?? "unparseable cron pattern",
        });
      }

      // 4. Composition gate — the dispatcher must be wired.
      if (args.updateSchedule === undefined) {
        return reply.code(503).send({
          error: "scheduler_unavailable",
          reason: "agent dispatcher not wired at boot — check engine logs",
        });
      }

      // 5. Look up every enabled instance scoped to the agent
      //    slug WITH a current schedule_cron. The operator can
      //    only edit cadences for instances that are already
      //    scheduled; an instance with NULL schedule_cron has
      //    never been registered and the create-instance flow is
      //    a separate verb (out of scope for v0.1 — see
      //    DECISIONS.md "instance creation UI").
      const instancesResult = (await args.db.execute(sql`
        SELECT id::text         AS id,
               name             AS name,
               schedule_cron    AS old_cron
        FROM agent_instances
        WHERE definition_slug = ${agentSlug}
          AND enabled = true
          AND schedule_cron IS NOT NULL
        ORDER BY created_at ASC
      `)) as unknown as {
        rows: Array<{
          id: string;
          name: string;
          old_cron: string;
        }>;
      };
      const rows = instancesResult.rows;
      if (rows.length === 0) {
        return reply.code(404).send({
          error: "agent_unknown",
          agentSlug,
        });
      }

      // Capture the FIRST instance's old cron for the audit
      // metadata. v0.1 keeps every instance of the same agent on
      // the same cadence (the UI editor flips them in lockstep)
      // so the first row is representative; the audit row also
      // carries `instance_count` for full forensic context.
      const oldCron = rows[0]!.old_cron;

      // 6. Run the DB UPDATE + dispatcher swap + audit row
      //    inside ONE transaction. A throw at any step rolls
      //    everything back; the dispatcher's `updateSchedule`
      //    additionally tries to roll its OWN BullMQ state
      //    forward on a partial-swap failure (see
      //    `agent-dispatcher.ts:updateSchedule`). The audit row
      //    is written FIRST so it shares the transaction
      //    rollback (audit-before-side-effect, but inside the
      //    same atom — rollback erases the row entirely).
      try {
        await args.db.transaction(async (tx) => {
          await tx.execute(sql`
            UPDATE agent_instances
            SET schedule_cron = ${newCron},
                updated_at    = now()
            WHERE definition_slug = ${agentSlug}
              AND enabled = true
              AND schedule_cron IS NOT NULL
          `);
          // The audit-log writer takes a Drizzle handle — pass
          // the transaction so the INSERT shares the unwind
          // boundary. Cast through the same shape `writeAuditLog`
          // uses elsewhere.
          await writeAuditLog(
            tx as unknown as Db,
            {
              action: "scheduler.update",
              userId: ctx.userId,
              metadata: {
                agent_slug: agentSlug,
                old_cron: oldCron,
                new_cron: newCron,
                instance_count: rows.length,
                caller_username: ctx.username,
              },
              sourceIp: req.ip,
              userAgent: req.headers["user-agent"],
            },
          );
          // BullMQ swap LAST — a throw here unwinds the SQL
          // UPDATE + the audit INSERT, so the operator's trail
          // matches the actual state. The dispatcher's
          // `updateSchedule` is best-effort transactional from
          // the operator's perspective (remove + add per entry,
          // with a roll-forward on partial failure).
          await args.updateSchedule!({
            entries: rows.map((r) => ({
              instanceId: r.id,
              definitionSlug: agentSlug,
              name: r.name,
              oldCron: r.old_cron,
              newCron,
            })),
          });
        });
      } catch (err) {
        return reply.code(500).send({
          error: "update_failed",
          reason: safeErrorMessage(err),
        });
      }

      // 7. Compute the next 5 fires for the response so the UI
      //    can render the confirmation preview without a second
      //    round-trip to the server. Cron parser is invoked
      //    locally — same `tz: 'UTC'` invariant the dispatcher
      //    uses (matches what BullMQ scheduled).
      const fromTs = now();
      const fires: string[] = [];
      try {
        const expr = cronParser.parseExpression(newCron, {
          tz: "UTC",
          currentDate: fromTs,
        });
        for (let i = 0; i < NEXT_FIRES_PREVIEW_COUNT; i += 1) {
          fires.push(expr.next().toDate().toISOString());
        }
      } catch {
        // The pattern was already validated above; reaching this
        // catch would imply a defect in cron-parser. Swallow so
        // the success response still goes through (the cron is
        // already persisted + scheduled).
      }

      return reply.code(200).send({
        agent: agentSlug,
        cron: newCron,
        instanceCount: rows.length,
        nextFires: fires,
      });
    },
  );
}

function isEditableSlug(value: string): value is SchedulerEditableSlug {
  return (SCHEDULER_EDITABLE_SLUGS as readonly string[]).includes(value);
}

/** Load the domain slug for the FIRST entry in
 *  `agent_instances.scope_domain_ids` per instance id. v0.1
 *  single-domain pilots match the runner closures'
 *  `resolveDomainSlug` lookup pattern in
 *  `cli/src/provision/agent-runners.ts`. */
async function loadDomainSlugMap(
  db: Db,
  instanceIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (instanceIds.length === 0) return out;
  const idParams = sql.join(
    instanceIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const result = (await db.execute(sql`
    SELECT ai.id::text                            AS instance_id,
           d.slug                                 AS domain_slug
    FROM agent_instances ai
    LEFT JOIN domains d ON d.id = (ai.scope_domain_ids)[1]
    WHERE ai.id::text IN (${idParams})
  `)) as unknown as { rows: InstanceDomainRow[] };
  for (const row of result.rows) {
    if (row.domain_slug !== null) {
      out.set(row.instance_id, row.domain_slug);
    }
  }
  return out;
}

/** Load the most recent `agent_runs.started_at` per instance id. */
async function loadLastFireMap(
  db: Db,
  instanceIds: readonly string[],
): Promise<Map<string, Date | string | null>> {
  const out = new Map<string, Date | string | null>();
  if (instanceIds.length === 0) return out;
  // Aggregate in one query rather than N+1 — operator may have
  // many scheduled instances. Use sql.join for parameterized IN
  // binding so Postgres treats the ids as values (not as SQL
  // text); ids are scheduler-internal but defence-in-depth keeps
  // the boundary clean if an upstream ever lets an attacker shape
  // a RegisteredSchedule.instanceId.
  const idParams = sql.join(
    instanceIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const result = (await db.execute(sql`
    SELECT instance_id::text AS instance_id,
           MAX(started_at)   AS started_at
    FROM agent_runs
    WHERE instance_id::text IN (${idParams})
    GROUP BY instance_id
  `)) as unknown as { rows: AgentRunStartedRow[] };
  for (const row of result.rows) {
    out.set(row.instance_id, row.started_at);
  }
  return out;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * On-demand agent dispatch — `POST /api/admin/agents/:slug/dispatch`
 * (PR-R3, phase-a appendix #10).
 *
 * Operators trigger Heartbeat / Lint / Surfacer / Builder on demand
 * from the management UI without waiting for the cron tick. The
 * route enqueues a one-shot BullMQ job onto the SAME
 * `selfop.dispatch` queue scheduled dispatches use, so the same
 * Worker handler + agent harness terminalisation path apply (run
 * row, SSE lifecycle events, deny-list checks, output-channel
 * delivery — every invariant the cron path enforces still applies).
 *
 * Input validation:
 *   - `:slug`        — URL param; must match the kebab-case slug
 *                      pattern + appear in the runtime allow-list
 *                      below (Heartbeat / Lint / Surfacer / Builder).
 *   - `domainSlug`   — body; kebab-case; resolves to a
 *                      `domains.id` row.
 *   - `instanceSlug` — optional body; length-bound only (1–128
 *                      chars). `agent_instances.name` is plain
 *                      `text` in the DB with no kebab-case
 *                      constraint, so a kebab-only validator
 *                      would refuse legitimate names like
 *                      "Heartbeat 06:00". The audit row records
 *                      the RESOLVED `agent_instances.name` from
 *                      the DB lookup, not the raw request — so
 *                      the no-freeform-text invariant is
 *                      preserved by the DB lookup being the
 *                      authoritative source. When omitted, the
 *                      handler defaults to the FIRST instance
 *                      scoped to the domain by `created_at`.
 *   - `dryRun`       — optional body boolean; threaded into
 *                      `inputs.dryRun` for the agent body to honor.
 *
 * Rate-limit: in-memory token bucket — 5 dispatches per hour per
 * `(agent_slug, user_id, domain_slug)` triple. The bucket is
 * intentionally NOT persisted (no new DB table per spec); a process
 * restart resets it. With 5/hr the operator has plenty of headroom
 * for a fix-and-rerun cycle while a runaway click can't fork-bomb
 * the queue.
 *
 * Audit: ONE `agent.dispatch_now` row written BEFORE the BullMQ
 * enqueue confirms — so a partial enqueue still leaves an audit
 * trail. The audit metadata records `agent_slug`, `domain_slug`,
 * `instance_slug` (resolved), `instance_id` (for direct lookup),
 * `dry_run`, and `caller_username`. `job_id` is NOT recorded
 * because the audit row is written BEFORE the BullMQ enqueue
 * (audit-before-enqueue invariant) — the jobId does not exist
 * yet at write time. Operators correlate via the
 * (caller_username, instance_id, created_at) tuple. NEVER any
 * free-form text from the operator (THREAT-MODEL §3.13).
 *
 * Auth: `requireAdminContext` + `requireCsrf` on the route
 * preHandler. `requireAdminContext` is implicitly satisfied by
 * `verifyAdmin` chained via `makeGuardedApp` in `index.ts`.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { safeErrorMessage } from "@opencoo/shared/scrub";

import { writeAuditLog } from "../audit-log.js";
import { requireAdminContext } from "../auth.js";
import { requireCsrf } from "../csrf.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Closed allow-list of agent slugs the on-demand path can fire.
 *  The four schedulable / operator-fireable agents in v0.1.
 *  Adding a slug here MUST be paired with a registered runner in
 *  the production `AgentRunnerRegistry` — the dispatcher's runner
 *  lookup will throw otherwise (and the harness records a `failed`
 *  agent_runs row). The slug list is duplicated in the UI's
 *  i18n `agentsRunNow.agents.*` map; keep them in lockstep. */
export const DISPATCHABLE_AGENT_SLUGS = [
  "heartbeat",
  "lint",
  "surfacer",
  "builder",
] as const;

export type DispatchableAgentSlug = (typeof DISPATCHABLE_AGENT_SLUGS)[number];

/** Kebab-case slug pattern for `domainSlug` + the URL `:slug`
 *  param. Lower alpha + digits + hyphens, must start with a
 *  letter, 1–63 chars. Mirrors the same constraint the domain-
 *  create flow uses (admin-api/routes/domains.ts).
 *
 *  NOTE: `instanceSlug` deliberately does NOT use this pattern.
 *  `agent_instances.name` is plain `text` in the DB (no
 *  kebab-case constraint at the schema level), so legitimate
 *  non-kebab names like "Heartbeat 06:00" must be dispatchable.
 *  The audit row records the RESOLVED `agent_instances.name`
 *  from the DB lookup (not the raw request body), so the no-
 *  freeform-text invariant is preserved by the DB lookup being
 *  the authoritative source. */
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

/** Length bound for `instanceSlug`. The DB column is `text` with
 *  no length cap, but the admin API rejects values longer than
 *  this so an attacker-supplied body can't blow row sizes via
 *  the instance-name lookup. Mirrors a generous-but-bounded UX
 *  ceiling — operator-named instances are always shorter. */
const INSTANCE_NAME_MAX_LEN = 128;

const dispatchBodySchema = z
  .object({
    domainSlug: z.string().regex(SLUG_PATTERN),
    instanceSlug: z
      .string()
      .min(1)
      .max(INSTANCE_NAME_MAX_LEN)
      .optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

/** Token-bucket entry. `tokens` is the count remaining; `refillAt`
 *  is the ms-epoch timestamp at which the bucket fully refills. */
interface BucketEntry {
  tokens: number;
  refillAt: number;
}

/** PR-R3 rate-limit constants. 5 dispatches per hour per
 *  (agent_slug × user_id × domain_slug) — generous for
 *  fix-and-rerun cycles, tight enough to prevent fork-bombs. */
const RATE_LIMIT_BUCKET_SIZE = 5;
const RATE_LIMIT_REFILL_WINDOW_MS = 60 * 60 * 1000;

/** In-memory rate-limit map. Module-level so a single process's
 *  bucket survives across requests but resets on restart (the
 *  spec disallows a new DB table). The map is keyed by
 *  `${agent_slug}|${user_id}|${domain_slug}` — the load-bearing
 *  ordering is alphabetic so a future reorder doesn't silently
 *  fork buckets. */
const rateLimitBuckets = new Map<string, BucketEntry>();

/** @internal Test seam — flush the rate-limit map between tests so
 *  a prior test's bucket doesn't leak. */
export function __resetAgentDispatchRateLimit(): void {
  rateLimitBuckets.clear();
}

/** Build the bucket key. Centralised so a reorder of the triple
 *  doesn't silently invalidate every bucket. */
function bucketKeyFor(args: {
  readonly agentSlug: string;
  readonly userId: string;
  readonly domainSlug: string;
}): string {
  return `${args.agentSlug}|${args.userId}|${args.domainSlug}`;
}

/** Try to consume one token from the bucket for the given key.
 *  Returns `{ ok: true }` when consumption succeeded, or
 *  `{ ok: false, retryAfterSec }` when the bucket is empty. */
function consumeToken(
  key: string,
  now: number,
): { ok: true } | { ok: false; retryAfterSec: number } {
  const entry = rateLimitBuckets.get(key);
  if (entry === undefined || now >= entry.refillAt) {
    // Fresh bucket OR refill window has elapsed — start a new
    // bucket of `RATE_LIMIT_BUCKET_SIZE` tokens, consume one.
    rateLimitBuckets.set(key, {
      tokens: RATE_LIMIT_BUCKET_SIZE - 1,
      refillAt: now + RATE_LIMIT_REFILL_WINDOW_MS,
    });
    return { ok: true };
  }
  if (entry.tokens > 0) {
    entry.tokens -= 1;
    return { ok: true };
  }
  // Bucket empty AND not yet expired. Surface the wait window in
  // seconds (rounded up so an operator doesn't see "Retry-After: 0").
  const retryAfterSec = Math.max(1, Math.ceil((entry.refillAt - now) / 1000));
  return { ok: false, retryAfterSec };
}

/** Surface the dispatch callable. The dispatcher's
 *  `enqueueOneShot` is the production wiring; tests inject a stub
 *  that captures the call without round-tripping through BullMQ. */
export interface AgentDispatchEnqueue {
  (args: {
    readonly instanceId: string;
    readonly dryRun?: boolean;
  }): Promise<{ readonly jobId: string }>;
}

export interface RegisterAgentsDispatchRouteArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
  /** When `undefined`, the route registers but every POST returns
   *  503 (composition-incomplete: the dispatcher failed to compose
   *  at boot). Boot-tolerance per the same pattern as the rest of
   *  the admin API. */
  readonly dispatchAgentJob?: AgentDispatchEnqueue;
  /** @internal Test seam — overrides `Date.now()` for deterministic
   *  rate-limit assertions. */
  readonly now?: () => number;
}

interface DomainRow {
  id: string;
}

interface InstanceRow {
  id: string;
  name: string;
}

export function registerAgentsDispatchRoute(
  args: RegisterAgentsDispatchRouteArgs,
): void {
  const now = args.now ?? ((): number => Date.now());

  args.app.post(
    "/api/admin/agents/:slug/dispatch",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);

      // 1. Validate the URL slug against the closed dispatch set.
      const rawSlug = (req.params as { slug: string }).slug;
      if (!isDispatchableSlug(rawSlug)) {
        return reply.code(404).send({
          error: "agent_slug_unknown",
          slug: rawSlug,
        });
      }
      const agentSlug: DispatchableAgentSlug = rawSlug;

      // 2. Validate the body shape.
      const parsed = dispatchBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: "validation_failed",
          issues: parsed.error.issues,
        });
      }
      const { domainSlug, instanceSlug, dryRun } = parsed.data;

      // 3. Composition gate — the dispatcher must be wired.
      if (args.dispatchAgentJob === undefined) {
        return reply.code(503).send({
          error: "dispatcher_unavailable",
          reason: "agent dispatcher not wired at boot — check engine logs",
        });
      }

      // 4. Resolve the target domain id.
      const domainResult = (await args.db.execute(sql`
        SELECT id::text AS id
        FROM domains
        WHERE slug = ${domainSlug}
          AND disabled_at IS NULL
        LIMIT 1
      `)) as unknown as { rows: DomainRow[] };
      const domainRow = domainResult.rows[0];
      if (domainRow === undefined) {
        return reply.code(422).send({
          error: "domain_unknown",
          domainSlug,
        });
      }
      const domainId = domainRow.id;

      // 5. Resolve the target agent instance.
      //    a. `instanceSlug` provided → match by name within the
      //       (definition_slug, scope_domain_ids) join.
      //    b. omitted → first instance scoped to the domain by
      //       `created_at` ordering (deterministic).
      let instanceRow: InstanceRow | undefined;
      if (instanceSlug !== undefined) {
        const r = (await args.db.execute(sql`
          SELECT id::text AS id, name
          FROM agent_instances
          WHERE definition_slug = ${agentSlug}
            AND name = ${instanceSlug}
            AND enabled = true
            AND ${domainId}::uuid = ANY(scope_domain_ids)
          LIMIT 1
        `)) as unknown as { rows: InstanceRow[] };
        instanceRow = r.rows[0];
      } else {
        const r = (await args.db.execute(sql`
          SELECT id::text AS id, name
          FROM agent_instances
          WHERE definition_slug = ${agentSlug}
            AND enabled = true
            AND ${domainId}::uuid = ANY(scope_domain_ids)
          ORDER BY created_at ASC
          LIMIT 1
        `)) as unknown as { rows: InstanceRow[] };
        instanceRow = r.rows[0];
      }
      if (instanceRow === undefined) {
        return reply.code(422).send({
          error: "instance_unknown",
          agentSlug,
          domainSlug,
          ...(instanceSlug !== undefined ? { instanceSlug } : {}),
        });
      }

      // 6. Token-bucket rate-limit. Keyed by
      //    (agent_slug × user_id × domain_slug) per the spec. The
      //    bucket holds 5 tokens; 6th call within the hour hits
      //    429 with `Retry-After`.
      const bucketKey = bucketKeyFor({
        agentSlug,
        userId: ctx.userId,
        domainSlug,
      });
      const consume = consumeToken(bucketKey, now());
      if (!consume.ok) {
        reply.header("Retry-After", String(consume.retryAfterSec));
        return reply.code(429).send({
          error: "rate_limited",
          retryAfterSec: consume.retryAfterSec,
        });
      }

      // 7. Audit row BEFORE the enqueue — ordering per the
      //    THREAT-MODEL §3.13 + the PR brief: a partial enqueue
      //    (BullMQ throw mid-call) still leaves a forensic trail
      //    for the operator. The audit row reflects the ATTEMPT
      //    and CANNOT include the BullMQ `job_id` — the jobId
      //    does not exist yet at write time (it's only assigned
      //    when `Queue.add(...)` resolves below). Operators
      //    correlate via the (caller_username, instance_id,
      //    created_at) tuple the GET /audit-log surface already
      //    exposes.
      //
      //    Append-only invariant — `admin_audit_log` is only
      //    INSERTed (never UPDATEd) per the
      //    `opencoo/no-update-append-only` ESLint rule, so even
      //    if we wanted to backfill `job_id` after the enqueue
      //    succeeded we couldn't UPDATE this row. v0.1 keeps it
      //    simple: one row, written before the enqueue; the
      //    job_id is NOT in the metadata.
      await writeAuditLog(args.db, {
        action: "agent.dispatch_now",
        userId: ctx.userId,
        metadata: {
          agent_slug: agentSlug,
          domain_slug: domainSlug,
          instance_slug: instanceRow.name,
          instance_id: instanceRow.id,
          dry_run: dryRun ?? false,
          caller_username: ctx.username,
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });

      let jobId: string;
      try {
        const result = await args.dispatchAgentJob({
          instanceId: instanceRow.id,
          dryRun: dryRun ?? false,
        });
        jobId = result.jobId;
      } catch (err) {
        return reply.code(500).send({
          error: "enqueue_failed",
          reason: safeErrorMessage(err),
        });
      }

      return reply.code(200).send({
        // The `runId` field name is what the UI expects (it deep-
        // links into the Activity tab); we surface the BullMQ
        // jobId here, since the actual run id is generated on
        // `startRun` and not available synchronously. The UI's
        // SSE listener for `agent_run` events flips the button
        // state when the harness emits its first `running`
        // lifecycle event.
        jobId,
        agentSlug,
        domainSlug,
        instanceSlug: instanceRow.name,
        instanceId: instanceRow.id,
        dryRun: dryRun ?? false,
      });
    },
  );
}

function isDispatchableSlug(value: string): value is DispatchableAgentSlug {
  return (DISPATCHABLE_AGENT_SLUGS as readonly string[]).includes(value);
}

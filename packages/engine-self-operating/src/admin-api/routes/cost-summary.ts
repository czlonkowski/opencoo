/**
 * Cost analytics dashboard — `GET /api/admin/cost-summary`
 * (PR-R5, phase-a appendix #10).
 *
 * Surfaces per-domain × agent × tier spend so an operator can
 * see where the cents go without writing SQL against `llm_usage`.
 *
 * Read-only — no new write surface, no new persistence table,
 * no admin-audit row. The endpoint is admin-auth gated (the
 * guarded-app wrapper in `index.ts` chains `verifyAdmin`); CSRF
 * is not required because GETs are not state-changing.
 *
 * Response shape:
 *   {
 *     totalUsd:    number,
 *     period:      'day' | 'week' | 'month',
 *     rangeFrom:   ISO,
 *     rangeTo:     ISO,
 *     byBucket:    Array<{
 *       key, totalUsd, tokensIn, tokensOut, runs
 *     }>,
 *     budgetState: Array<{
 *       domainSlug, capUsd, usedUsd, projectedEomUsd, paused
 *     }>,
 *   }
 *
 * Aggregation:
 *   - byBucket groups the in-window `llm_usage` rows by the
 *     selected dimension (domain / model / tier / agent).
 *     Domain bucket key is the domain.slug — joined in SQL so
 *     the UI never has to resolve domain ids client-side. Rows
 *     whose `domain_id` is NULL (non-domain-scoped LLM calls
 *     such as bootstrap pings) are still counted toward
 *     `totalUsd` but bucketed under `(unscoped)` for the domain
 *     groupBy so they don't hide.
 *   - byBucket is sorted DESC by totalUsd; capped at 100 buckets
 *     so a tenant with 100+ agents can't blow the JSON size. The
 *     ORDER BY + LIMIT are pushed into SQL (rather than slicing in
 *     memory after a full fetch) so the database does the work and
 *     the wire payload stays bounded.
 *
 * Budget state:
 *   - One row per active (`disabled_at IS NULL`) domain.
 *   - usedUsd: month-to-date spend (always month-window even when
 *     `period=day|week`, because the cap is monthly).
 *   - projectedEomUsd: linear extrapolation
 *     `usedUsd / daysElapsed * daysInMonth`. The first day of the
 *     month uses `daysElapsed=1` to avoid divide-by-zero.
 *   - paused: hard-coded `false` in v0.1. The
 *     `domain_llm_budgets` pause table is not in this PR; PR-R5
 *     scope explicitly says "if domain_llm_budgets exists,
 *     read it; else paused: false". Defer until that table lands.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Maximum number of byBucket entries returned. A domain with
 *  100+ agents would otherwise blow the JSON size — the
 *  truncation cap is documented in the response and the UI
 *  surfaces a "showing top 100" notice. */
const MAX_BUCKETS = 100;

/** Bucket key used for `llm_usage` rows whose `domain_id` is
 *  NULL — non-domain-scoped calls (bootstrap pings, unscoped
 *  catalog ops). Bucketed under a sentinel key so they remain
 *  visible to the operator without being dropped from totals. */
const UNSCOPED_BUCKET_KEY = "(unscoped)";

const querySchema = z
  .object({
    period: z.enum(["day", "week", "month"]).default("month"),
    groupBy: z.enum(["domain", "model", "tier", "agent"]).default("domain"),
  })
  .strict();

type Period = z.infer<typeof querySchema>["period"];
type GroupBy = z.infer<typeof querySchema>["groupBy"];

/** Resolve the period window to (rangeFrom, rangeTo) ISO strings.
 *  - day:   trailing 24h
 *  - week:  trailing 7 days
 *  - month: 1st of the current calendar month → now
 *  Returned as Date objects so the SQL builder can re-cast and
 *  the response can `.toISOString()`. */
function resolvePeriodRange(period: Period, now: Date): {
  readonly from: Date;
  readonly to: Date;
} {
  const to = now;
  if (period === "day") {
    return { from: new Date(now.getTime() - 24 * 60 * 60 * 1000), to };
  }
  if (period === "week") {
    return { from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), to };
  }
  // month — calendar-aware: from = first second of the current
  // calendar month in UTC. Aligns with the per-domain monthly cap
  // semantic ("$50 per month") rather than a rolling 30-day window.
  const from = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  return { from, to };
}

/** Days elapsed in the current calendar month (1-based; the 1st
 *  counts as 1 elapsed day). Used by the linear projection. */
function daysElapsedInMonth(now: Date): number {
  return now.getUTCDate();
}

/** Total days in the current calendar month — depends on the
 *  month + leap year. */
function daysInMonth(now: Date): number {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  ).getUTCDate();
}

interface BucketRow {
  readonly key: string | null;
  readonly total_usd: string;
  readonly tokens_in: string;
  readonly tokens_out: string;
  readonly runs: string;
}

interface BudgetRow {
  readonly slug: string;
  readonly cap_usd: string | null;
  readonly used_usd: string;
}

export interface RegisterCostSummaryRouteArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
  /** @internal Test seam — overrides `Date.now()` for deterministic
   *  range / projection assertions. */
  readonly now?: () => Date;
}

export function registerCostSummaryRoute(
  args: RegisterCostSummaryRouteArgs,
): void {
  const nowFn = args.now ?? ((): Date => new Date());

  args.app.get("/api/admin/cost-summary", async (req, reply) => {
    const parseResult = querySchema.safeParse(req.query);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: "validation_failed",
        issues: parseResult.error.issues,
      });
    }
    const { period, groupBy } = parseResult.data;
    const now = nowFn();
    const { from, to } = resolvePeriodRange(period, now);

    // Aggregate the in-window rows by the selected dimension.
    // Drizzle's `sql` template handles parameterised values; the
    // group-key column is fixed by the `groupBy` switch (no user
    // input flows into raw SQL identifiers).
    const bucketResult = (await args.db.execute(
      buildBucketQuery(groupBy, from, to),
    )) as unknown as { rows: BucketRow[] };

    // Total of every in-window row (independent of groupBy or the
    // 100-bucket truncation — totals must reflect the full window).
    const totalResult = (await args.db.execute(sql`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS total_usd
      FROM llm_usage
      WHERE "timestamp" >= ${from.toISOString()}::timestamptz
        AND "timestamp" <= ${to.toISOString()}::timestamptz
    `)) as unknown as { rows: Array<{ total_usd: string }> };
    const totalUsd = Number(totalResult.rows[0]?.total_usd ?? "0");

    // Budget state: month-to-date spend per active domain.
    // LEFT JOIN llm_usage so domains with zero spend still appear.
    const monthRange = resolvePeriodRange("month", now);
    const budgetResult = (await args.db.execute(sql`
      SELECT
        d.slug,
        d.llm_budget_monthly_cap_usd::text AS cap_usd,
        COALESCE(SUM(u.cost_usd), 0)::text  AS used_usd
      FROM domains d
      LEFT JOIN llm_usage u
        ON u.domain_id = d.id
        AND u."timestamp" >= ${monthRange.from.toISOString()}::timestamptz
        AND u."timestamp" <= ${monthRange.to.toISOString()}::timestamptz
      WHERE d.disabled_at IS NULL
      GROUP BY d.id, d.slug, d.llm_budget_monthly_cap_usd
      ORDER BY d.slug ASC
    `)) as unknown as { rows: BudgetRow[] };

    const elapsed = Math.max(1, daysElapsedInMonth(now));
    const total = daysInMonth(now);
    const budgetState = budgetResult.rows.map((r) => {
      const used = Number(r.used_usd);
      const cap = r.cap_usd === null ? null : Number(r.cap_usd);
      const projected = (used / elapsed) * total;
      return {
        domainSlug: r.slug,
        capUsd: cap,
        usedUsd: used,
        projectedEomUsd: projected,
        paused: false, // domain_llm_budgets table not in v0.1 PR-R5 scope
      };
    });

    // ORDER BY total_usd DESC + LIMIT MAX_BUCKETS are applied in
    // the SQL itself (see buildBucketQuery), so the rows we read
    // back are already sorted and capped — no in-memory sort or
    // slice needed.
    const byBucket = bucketResult.rows.map((r) => ({
      key: r.key ?? UNSCOPED_BUCKET_KEY,
      totalUsd: Number(r.total_usd),
      tokensIn: Number(r.tokens_in),
      tokensOut: Number(r.tokens_out),
      runs: Number(r.runs),
    }));

    return reply.code(200).send({
      totalUsd,
      period,
      rangeFrom: from.toISOString(),
      rangeTo: to.toISOString(),
      byBucket,
      budgetState,
    });
  });
}

/** Per-groupBy SQL fragments. Closed-enum keyed; the values are
 *  hand-written SQL identifiers (never interpolated user input)
 *  so `sql.raw` is safe — same pattern used elsewhere in the
 *  admin-api for closed-enum identifiers (e.g. pipelines.ts).
 *
 *  Each row carries:
 *    - keyExpr — the column projected as `key`
 *    - groupExpr — the GROUP BY expression (matches keyExpr)
 *    - join — extra JOIN clause (only the domain bucket needs one) */
const BUCKET_DIMENSIONS: Readonly<
  Record<GroupBy, { readonly keyExpr: string; readonly groupExpr: string; readonly join: string }>
> = {
  domain: {
    keyExpr: "d.slug",
    groupExpr: "d.slug",
    join: "LEFT JOIN domains d ON d.id = u.domain_id",
  },
  tier: { keyExpr: "u.tier::text", groupExpr: "u.tier", join: "" },
  model: { keyExpr: "u.model", groupExpr: "u.model", join: "" },
  agent: {
    keyExpr: "u.pipeline_or_agent",
    groupExpr: "u.pipeline_or_agent",
    join: "",
  },
};

/** Build the bucket-aggregation SQL for a chosen groupBy. The
 *  groupBy is from a closed enum, not user-supplied identifier —
 *  the column / GROUP BY expressions come from the static
 *  `BUCKET_DIMENSIONS` map so the query plan stays predictable
 *  and there's no string interpolation of user input into the
 *  SQL identifier space. */
function buildBucketQuery(
  groupBy: GroupBy,
  from: Date,
  to: Date,
): ReturnType<typeof sql> {
  const dim = BUCKET_DIMENSIONS[groupBy];
  // ORDER BY total_usd DESC + LIMIT happen in SQL so the database
  // returns at most MAX_BUCKETS rows (DESC by cost). MAX_BUCKETS is
  // bound as a parameterised value rather than interpolated raw —
  // it's a static int today, but the parameterised form is the
  // safe pattern and keeps a single source of truth in JS.
  return sql`
    SELECT
      ${sql.raw(dim.keyExpr)}              AS key,
      COALESCE(SUM(u.cost_usd), 0)::text   AS total_usd,
      COALESCE(SUM(u.tokens_in), 0)::text  AS tokens_in,
      COALESCE(SUM(u.tokens_out), 0)::text AS tokens_out,
      COUNT(*)::text                       AS runs
    FROM llm_usage u
    ${sql.raw(dim.join)}
    WHERE u."timestamp" >= ${from.toISOString()}::timestamptz
      AND u."timestamp" <= ${to.toISOString()}::timestamptz
    GROUP BY ${sql.raw(dim.groupExpr)}
    ORDER BY COALESCE(SUM(u.cost_usd), 0) DESC
    LIMIT ${MAX_BUCKETS}
  `;
}

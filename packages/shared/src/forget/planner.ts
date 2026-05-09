/**
 * `planForget(db, bindingId)` — pure read-only impact planner for
 * `source forget` (PR-R7, phase-a appendix #10).
 *
 * The planner answers a single question: "if this binding's
 * contributions to the wiki are removed, what changes?". It is the
 * shared kernel behind both surfaces:
 *
 *   • CLI `opencoo source forget --dry-run` (when wired)
 *   • Admin API `POST /api/admin/source-bindings/:id/forget?dryRun=1`
 *
 * Shape of the result:
 *
 *   - `pagesRecompiled` — wiki paths that have OTHER bindings
 *     citing them; removing this source leaves the page intact but
 *     with one fewer source contributing → recompile required so
 *     the merged page reflects reality. SORTED.
 *   - `pagesDeleted` — wiki paths whose ONLY citation source is
 *     this binding; with this source forgotten, the page has no
 *     remaining attribution and must be removed entirely. SORTED.
 *   - `citationsRemoved` — total `page_citations` rows attributable
 *     to this binding, regardless of whether the page survives or
 *     deletes. (`page_citations` is append-only per THREAT-MODEL
 *     §2 invariant 8 — the rows themselves are NOT deleted; this
 *     count surfaces what would orphan if they were.)
 *
 * Why split recompile vs delete:
 *
 *   - Recompile is cheap (an LLM call, capped by the Thinker's
 *     usual budget) and reversible (the next ingestion replays
 *     content back in).
 *   - Delete consumes the wiki-write daily-cap budget and is
 *     irreversible without a Gitea history rewrite. The operator
 *     must SEE the delete count before confirming, and the route
 *     gates execution behind the cap (THREAT-MODEL §2 invariant 6
 *     — bounded blast radius for destructive operations).
 *
 * Implementation note — single SQL query:
 *
 *   We aggregate per `(domain_slug, page_path)` for pages this
 *   binding cites, then count distinct OTHER-binding citers. Zero
 *   other citers ⇒ delete; ≥1 other citer ⇒ recompile. One round
 *   trip; no per-page sub-query, no N+1.
 *
 * @see `routes/source-bindings.ts` for the route wiring + cap check.
 * @see `daily-cap.ts` for the cap state the route reads.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Result of `planForget`. Path lists are SORTED so two consecutive
 *  dry-runs produce byte-identical output (idempotent — pinned by
 *  `source-binding-forget.test.ts`'s "consecutive dry-runs" case). */
export interface ForgetPlan {
  /** Wiki paths that survive this forget (other bindings still cite
   *  them) but must recompile to drop this source's contribution.
   *  Format: `${domainSlug}/${pagePath}`. */
  readonly pagesRecompiled: readonly string[];
  /** Wiki paths whose only citation source is this binding;
   *  removing this source leaves no attribution so the page deletes
   *  entirely. Format: `${domainSlug}/${pagePath}`. */
  readonly pagesDeleted: readonly string[];
  /** Total citation rows attributable to this binding. */
  readonly citationsRemoved: number;
  /** Domain slug the binding targets. Surfaces so the route can
   *  scope the daily-cap check to the right domain in one place. */
  readonly domainSlug: string;
}

export interface PlanForgetArgs {
  readonly db: Db;
  readonly bindingId: string;
}

/** Sentinel returned when the binding does not exist. The route
 *  maps to 404; the CLI surfaces a user error. Distinguishing
 *  "no binding" from "binding cites zero pages" is load-bearing
 *  for the 404 path. */
export type PlanForgetResult = ForgetPlan | { readonly notFound: true };

export async function planForget(
  args: PlanForgetArgs,
): Promise<PlanForgetResult> {
  // Look up the binding's target domain slug. Two purposes:
  //   1. Existence check (404 on miss).
  //   2. Scope the cap check to the right domain (the cap is per
  //      `domain_slug` per `daily-cap.ts`).
  const bindingResult = (await args.db.execute(sql`
    SELECT d.slug AS domain_slug
    FROM sources_bindings b
    JOIN domains d ON d.id = b.domain_id
    WHERE b.id = ${args.bindingId}::uuid
    LIMIT 1
  `)) as unknown as { rows: Array<{ domain_slug: string }> };
  const bindingRow = bindingResult.rows[0];
  if (bindingRow === undefined) {
    return { notFound: true };
  }
  const domainSlug = bindingRow.domain_slug;

  // Single aggregate query — for each page this binding cites,
  // count the number of OTHER bindings citing the same
  // `(domain_slug, page_path)`. The CTE materialises the candidate
  // set once; the outer SELECT reads it twice (existence + total).
  const planResult = (await args.db.execute(sql`
    WITH cited AS (
      SELECT DISTINCT pc.domain_slug, pc.page_path
      FROM page_citations pc
      WHERE pc.source_binding_id = ${args.bindingId}::uuid
    )
    SELECT
      c.domain_slug AS domain_slug,
      c.page_path   AS page_path,
      (
        SELECT COUNT(DISTINCT o.source_binding_id)::int
        FROM page_citations o
        WHERE o.domain_slug = c.domain_slug
          AND o.page_path   = c.page_path
          AND o.source_binding_id <> ${args.bindingId}::uuid
      ) AS other_citers
    FROM cited c
    ORDER BY c.domain_slug, c.page_path
  `)) as unknown as {
    rows: Array<{
      domain_slug: string;
      page_path: string;
      other_citers: number;
    }>;
  };

  const recompile: string[] = [];
  const deletes: string[] = [];
  for (const row of planResult.rows) {
    const fullPath = `${row.domain_slug}/${row.page_path}`;
    if (row.other_citers > 0) {
      recompile.push(fullPath);
    } else {
      deletes.push(fullPath);
    }
  }

  // Total citation count — rows attributable to this binding,
  // independent of whether the page survives or deletes.
  const citationsResult = (await args.db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM page_citations
    WHERE source_binding_id = ${args.bindingId}::uuid
  `)) as unknown as { rows: Array<{ n: number }> };
  const citationsRemoved = citationsResult.rows[0]?.n ?? 0;

  return {
    pagesRecompiled: recompile,
    pagesDeleted: deletes,
    citationsRemoved,
    domainSlug,
  };
}

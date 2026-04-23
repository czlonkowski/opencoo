import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { DomainId } from "../db/brands.js";

// Drizzle's `PgDatabase` generic lets any postgres backend (node-postgres
// in prod, pglite in tests) satisfy the dep without forcing the
// cost-tracker to know the driver-specific type.
export type CostTrackerDb = PgDatabase<
  PgQueryResultHKT,
  Record<string, unknown>
>;

// Sum `cost_usd` on `llm_usage` for the given domain, restricted to
// rows whose `timestamp` is at or after the start of the current
// month (UTC per Postgres' `date_trunc`). Rows with NULL `domain_id`
// are never counted — they exist for bootstrap-time pings that
// aren't associated with any domain's cap.
//
// Returns a plain `number` — callers compare against the domain's
// numeric cap. For capacity reasoning this is fine up to ~9e15; our
// caps are monthly USD so we're ~16 orders of magnitude inside IEEE
// 754 precision territory.
export async function computeMonthToDateCost(
  db: CostTrackerDb,
  domainId: DomainId,
): Promise<number> {
  const result = (await db.execute(sql`
    SELECT COALESCE(SUM(cost_usd), 0)::text AS total
    FROM llm_usage
    WHERE domain_id = ${domainId}
      AND timestamp >= date_trunc('month', now())
  `)) as { rows: Array<{ total: string }> } | Array<{ total: string }>;
  const list = Array.isArray(result) ? result : result.rows;
  const first = list[0];
  const totalStr = first?.total ?? "0";
  return Number.parseFloat(totalStr);
}

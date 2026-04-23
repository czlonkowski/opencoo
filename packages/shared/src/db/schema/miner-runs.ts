import { sql } from "drizzle-orm";
import { index, integer, numeric, pgTable, timestamp } from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId, requiredRestrictFk } from "./columns.js";
import { catalogClass } from "./enums.js";
import { sourcesBindings } from "./sources-bindings.js";

// One row per SkillMiner run (§6.9). Rolls up the scanning window,
// candidate/suppression counts, and the run's own cost + latency so
// the heartbeat can report "we looked at N transcripts and proposed M
// candidates this week" without re-scanning.
export const minerRuns = pgTable(
  "miner_runs",
  {
    id: primaryKeyId(),
    minerBindingId: requiredRestrictFk(
      "miner_binding_id",
      () => sourcesBindings.id,
    ),
    class: catalogClass("class").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    candidateCount: integer("candidate_count").notNull().default(0),
    suppressedCount: integer("suppressed_count").notNull().default(0),
    tokensTotal: integer("tokens_total").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 })
      .notNull()
      .default(sql`'0'`),
    latencyMs: integer("latency_ms").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("miner_runs_miner_binding_id_created_at_idx").on(
      t.minerBindingId,
      t.createdAt,
    ),
  ],
);

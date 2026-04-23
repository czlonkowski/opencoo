import {
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId } from "./columns.js";
import { llmEngine, llmTier } from "./enums.js";

// The cost+latency audit for every LLM call routed through `llm-router`
// (architecture §8.3). One row per call — clients use this to see where
// their cents go and to cap per-domain monthly spend.
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: primaryKeyId(),
    // Column name intentionally matches §8.3 "timestamp" — a reserved word
    // in PG that Drizzle quotes automatically in the generated SQL.
    timestamp: timestamp("timestamp", { withTimezone: true })
      .notNull()
      .defaultNow(),
    engine: llmEngine("engine").notNull(),
    tier: llmTier("tier").notNull(),
    model: text("model").notNull(),
    pipelineOrAgent: text("pipeline_or_agent").notNull(),
    documentId: text("document_id"),
    // FK to agent_runs(id) deferred to PR 04 (same pattern as page_citations).
    runId: uuid("run_id"),
    tokensIn: integer("tokens_in").notNull(),
    tokensOut: integer("tokens_out").notNull(),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull(),
    latencyMs: integer("latency_ms").notNull(),
    promptVersion: text("prompt_version"),
    createdAt: createdAt(),
  },
  (t) => [
    index("llm_usage_timestamp_idx").on(t.timestamp),
    index("llm_usage_pipeline_or_agent_timestamp_idx").on(
      t.pipelineOrAgent,
      t.timestamp,
    ),
  ],
);

import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId } from "./columns.js";
import { llmUsage } from "./llm-usage.js";

// APPEND-ONLY per THREAT-MODEL §2 invariant 8. Sibling to `llm_usage`
// that carries the RAW prompt + response text, gated on `LLM_DEBUG_LOG=1`.
// The row is written in the same transaction as the parent `llm_usage`
// row (see llm-router.ts) so the pairing is atomic: either both land
// or neither does. Cascade on `usage_id` DELETE keeps the two aligned
// if Cleanup prunes a `llm_usage` row; TTL-based pruning (7-day
// retention by default per THREAT-MODEL §2 invariant 11) lands in
// PR 17 and targets `created_at`.
export const llmUsageDebug = pgTable(
  "llm_usage_debug",
  {
    id: primaryKeyId(),
    usageId: uuid("usage_id")
      .notNull()
      .references(() => llmUsage.id, { onDelete: "cascade" }),
    promptText: text("prompt_text").notNull(),
    responseText: text("response_text").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("llm_usage_debug_created_at_idx").on(t.createdAt)],
);

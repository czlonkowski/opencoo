import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId } from "./columns.js";
import { domains } from "./domains.js";
import { guardFailMode } from "./enums.js";
import { sourcesBindings } from "./sources-bindings.js";
import type { MatchedByteRange } from "../types/index.js";

// APPEND-ONLY per THREAT-MODEL §2 invariant 8. Metadata-only per §3.3:
// records that a redaction fired at (pipeline, guard, category) with
// which matched BYTE RANGES — the matched CONTENT is NEVER persisted,
// only the offsets. Reviewing the original requires going back to the
// source system.
export const redactionEvents = pgTable(
  "redaction_events",
  {
    id: primaryKeyId(),
    pipeline: text("pipeline").notNull(),
    domainId: uuid("domain_id").references(() => domains.id, {
      onDelete: "restrict",
    }),
    bindingId: uuid("binding_id").references(() => sourcesBindings.id, {
      onDelete: "restrict",
    }),
    guardSlug: text("guard_slug").notNull(),
    category: text("category").notNull(),
    patternVersion: text("pattern_version").notNull(),
    matchedByteRanges: jsonb("matched_byte_ranges")
      .$type<MatchedByteRange[]>()
      .notNull(),
    failMode: guardFailMode("fail_mode").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("redaction_events_pipeline_created_at_idx").on(
      t.pipeline,
      t.createdAt,
    ),
  ],
);

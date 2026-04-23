import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId, updatedAt } from "./columns.js";
import { domains } from "./domains.js";
import { catalogCandidateStatus, catalogClass } from "./enums.js";
import { minerRuns } from "./miner-runs.js";
import { users } from "./users.js";
import type { DraftPayload, EvidenceRef } from "../types/index.js";

// MUTATION-ADJACENT table. Unlike the four §2 invariant-8 append-only
// tables in this PR, `catalog_candidate.status` and `reviewed_*` are
// sanctioned UPDATE targets — the 6-state state machine transitions
// detected → drafted → reviewing → approved/rejected → promoted as the
// Review Dashboard operator moves through. THREAT-MODEL §2 invariant 8
// is amended in this PR to note this carve-out explicitly.
export const catalogCandidate = pgTable(
  "catalog_candidate",
  {
    id: primaryKeyId(),
    minerRunId: uuid("miner_run_id")
      .notNull()
      .references(() => minerRuns.id, { onDelete: "restrict" }),
    catalogDomainId: uuid("catalog_domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "restrict" }),
    class: catalogClass("class").notNull(),
    status: catalogCandidateStatus("status").notNull().default("detected"),
    patternFingerprint: text("pattern_fingerprint").notNull(),
    evidenceRefs: jsonb("evidence_refs").$type<EvidenceRef[]>().notNull(),
    draftPayload: jsonb("draft_payload").$type<DraftPayload>().notNull(),
    reviewedBy: uuid("reviewed_by").references(() => users.id, {
      onDelete: "restrict",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("catalog_candidate_status_idx").on(t.status),
    index("catalog_candidate_miner_run_id_idx").on(t.minerRunId),
  ],
);

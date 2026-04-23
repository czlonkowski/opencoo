import { pgTable, text, unique, uuid } from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId } from "./columns.js";
import { domains } from "./domains.js";
import { users } from "./users.js";

// APPEND-ONLY per THREAT-MODEL §2 invariant 8. Operator suppressions
// of noisy miner patterns — a reviewer decides "stop proposing this
// again", the pattern fingerprint lands here, and the next miner run
// filters against (catalog_domain_id, pattern_fingerprint).
export const minerSuppressions = pgTable(
  "miner_suppressions",
  {
    id: primaryKeyId(),
    catalogDomainId: uuid("catalog_domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "restrict" }),
    patternFingerprint: text("pattern_fingerprint").notNull(),
    reviewerId: uuid("reviewer_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("miner_suppressions_catalog_domain_fingerprint_unique").on(
      t.catalogDomainId,
      t.patternFingerprint,
    ),
  ],
);

import { pgTable, text, unique } from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId, requiredRestrictFk } from "./columns.js";
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
    catalogDomainId: requiredRestrictFk("catalog_domain_id", () => domains.id),
    patternFingerprint: text("pattern_fingerprint").notNull(),
    reviewerId: requiredRestrictFk("reviewer_id", () => users.id),
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

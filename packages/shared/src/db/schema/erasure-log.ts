import { index, pgTable, text } from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId, requiredRestrictFk } from "./columns.js";
import { erasureAction } from "./enums.js";
import { sourcesBindings } from "./sources-bindings.js";
import { users } from "./users.js";

// APPEND-ONLY per THREAT-MODEL §2 invariant 8. One row per admin-triggered
// erasure verb (§15): purge_intake, purge_webhooks, purge_llm_debug,
// recompile_page, delete_page. Proves the admin ran the action against
// `target_ref` at `created_at`. Deleting an erasure_log row would defeat
// the whole point — the admin CLI refuses.
export const erasureLog = pgTable(
  "erasure_log",
  {
    id: primaryKeyId(),
    bindingId: requiredRestrictFk("binding_id", () => sourcesBindings.id),
    action: erasureAction("action").notNull(),
    targetRef: text("target_ref").notNull(),
    executedBy: requiredRestrictFk("executed_by", () => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("erasure_log_binding_id_created_at_idx").on(
      t.bindingId,
      t.createdAt,
    ),
  ],
);

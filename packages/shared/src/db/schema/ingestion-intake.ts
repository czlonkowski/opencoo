import { pgTable, text, unique } from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId, requiredRestrictFk } from "./columns.js";
import { errorClass, intakeStatus } from "./enums.js";
import { sourcesBindings } from "./sources-bindings.js";

export const ingestionIntake = pgTable(
  "ingestion_intake",
  {
    id: primaryKeyId(),
    bindingId: requiredRestrictFk("binding_id", () => sourcesBindings.id),
    sourceDocId: text("source_doc_id").notNull(),
    sourceRevision: text("source_revision").notNull(),
    contentHash: text("content_hash").notNull(),
    status: intakeStatus("status").notNull().default("pending"),
    lastClassifierRunId: text("last_classifier_run_id"),
    errorClass: errorClass("error_class"),
    /** Human-readable error message (free-form text). Complements
     *  `error_class` (enum) with the actual diagnostic detail.
     *  The GET /api/admin/source-bindings handler surfaces this as
     *  `lastError` in preference to `error_class` where available. */
    errorText: text("error_text"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("ingestion_intake_binding_doc_revision_unique").on(
      t.bindingId,
      t.sourceDocId,
      t.sourceRevision,
    ),
  ],
);

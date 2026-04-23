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

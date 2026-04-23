import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId } from "./columns.js";
import { sourcesBindings } from "./sources-bindings.js";

// APPEND-ONLY per THREAT-MODEL §2 invariant 8: no updated_at, no $onUpdate,
// no mutation-path writes after insert. Source forgetting happens via
// DELETE (retention/erasure), not UPDATE.
export const pageCitations = pgTable(
  "page_citations",
  {
    id: primaryKeyId(),
    domainSlug: text("domain_slug").notNull(),
    pagePath: text("page_path").notNull(),
    sourceBindingId: uuid("source_binding_id")
      .notNull()
      .references(() => sourcesBindings.id, { onDelete: "restrict" }),
    sourceRef: text("source_ref").notNull(),
    // FK to agent_runs(id) is declared without .references() — the target
    // table lands in PR 04, which adds the FK via its own migration.
    compiledByRunId: uuid("compiled_by_run_id"),
    promptVersion: text("prompt_version"),
    createdAt: createdAt(),
  },
  (t) => [
    index("page_citations_domain_slug_page_path_idx").on(
      t.domainSlug,
      t.pagePath,
    ),
    index("page_citations_source_binding_id_idx").on(t.sourceBindingId),
  ],
);

/**
 * Lint agent definition (architecture §9.3). Read-only; the
 * engine post-run hook routes findings to the bound output
 * channel. v0.1 shape: 5 detectors (wildcard_bindings,
 * stale_pages, orphans, prompt_version_drift, contradictions);
 * the 6th `automation_drift` detector lands in plan #92 part B
 * alongside the harness's `callerPat` reintroduction.
 */
import type { AgentDefinition } from "../../agent-harness/index.js";

export const LINT_DEFINITION: AgentDefinition = {
  slug: "lint",
  version: "1.0.0",
  description:
    "Weekly read-only lint over a domain — wildcard bindings, stale pages, orphans, prompt drift, contradictions.",
  outputSchemaName: "LintOutput",
  defaultMemory: { type: "none" },
};

/**
 * Lint agent definition (architecture §9.3). Read-only; the
 * engine post-run hook routes findings to the bound output
 * channel. v0.1 shape: 6 detectors (wildcard_bindings,
 * stale_pages, orphans, prompt_version_drift, contradictions,
 * automation_drift) — automation_drift was deferred to plan
 * #92 part B and lands here.
 */
import type { AgentDefinition } from "../../agent-harness/index.js";

export const LINT_DEFINITION: AgentDefinition = {
  slug: "lint",
  version: "1.0.0",
  description:
    "Weekly read-only lint over a domain — wildcard bindings, stale pages, orphans, prompt drift, contradictions, automation drift.",
  outputSchemaName: "LintOutput",
  defaultMemory: { type: "none" },
  // Read-only tool surface. Lint reads pages + worldview +
  // index over the domain it scans — same set as Heartbeat
  // plus wiki.read_page for the contradictions detector's
  // body fetch.
  toolNames: ["worldview.read", "index.search", "wiki.read_page"],
};

/**
 * Public surface for the Lint agent (PR 20). The composition
 * root (PR 30 CLI) registers the definition and wires the body
 * via `invokeAgent({ run: ctx => runLint(ctx, ...) })`.
 *
 * v0.1 detector roster (6 detectors):
 *   - wildcard_bindings, stale_pages, orphans,
 *     prompt_version_drift, contradictions (plan #92 part A)
 *   - automation_drift (plan #97 part B)
 */
export { LINT_DEFINITION } from "./definition.js";
export {
  AUTOMATION_DRIFT_WINDOW_DAYS,
  STALE_PAGES_DEFAULT_THRESHOLD_DAYS,
  WIKI_READ_PAGE_CONCURRENCY,
  currentLoaderPromptVersions,
  runLint,
  runLintCore,
  type RunLintArgs,
  type RunLintCoreArgs,
} from "./run.js";
export {
  LINT_FINDING_KINDS,
  LINT_FINDING_SCHEMA,
  LINT_OUTPUT_SCHEMA,
  type LintFinding,
  type LintFindingKind,
  type LintOutput,
} from "./types.js";

// Detector primitives — the orchestrator and PR 20.5
// `automation_drift` reuse these.
export {
  detectWildcardBindings,
  type WildcardBindingsInput,
} from "./detectors/wildcard-bindings.js";
export {
  detectStalePages,
  type PageNewestCitation,
  type StalePagesArgs,
} from "./detectors/stale-pages.js";
export {
  detectOrphans,
  type OrphansArgs,
} from "./detectors/orphans.js";
export {
  detectPromptVersionDrift,
  type PageNewestPromptVersion,
  type PromptVersionDriftArgs,
} from "./detectors/prompt-version-drift.js";
export {
  CONTRADICTIONS_OUTPUT_SCHEMA,
  CONTRADICTIONS_PAGE_CAP,
  detectContradictions,
  type ContradictionsArgs,
  type PageBody,
} from "./detectors/contradictions.js";
export {
  detectAutomationDrift,
  type AutomationDriftArgs,
  type ToolCallObservation,
} from "./detectors/automation-drift.js";

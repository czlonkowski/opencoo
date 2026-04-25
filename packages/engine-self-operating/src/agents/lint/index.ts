/**
 * Public surface for the Lint agent (PR 20, plan #92 part A).
 * The composition root (PR 30 CLI) registers the definition
 * and wires the body via
 * `invokeAgent({ run: ctx => runLint(ctx, ...) })`.
 *
 * Detector primitives are also exported so the orchestrator
 * integration test + future plan-#92-part-B `automation_drift`
 * detector can reuse the same shapes.
 */
export { LINT_DEFINITION } from "./definition.js";
export {
  STALE_PAGES_DEFAULT_THRESHOLD_DAYS,
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

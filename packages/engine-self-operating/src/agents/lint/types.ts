/**
 * Shared types for the Lint agent + its detectors. The Lint
 * orchestrator (`runLint`) loads the input data (bindings, page
 * citations, wiki page paths) once and fans out to every
 * detector; each detector returns a flat `LintFinding[]` keyed
 * by `kind` so the Review Dashboard can group + render.
 *
 * Detectors are PURE FUNCTIONS over their inputs — no DB
 * access, no I/O, no clock side-effects (the orchestrator
 * threads the clock through). This keeps each detector unit-
 * testable and means the contradictions detector is the only
 * one that calls the LLM.
 */
import { z } from "zod";

/**
 * Per-finding kind. Adding a new detector means adding a new
 * literal here AND wiring it into the orchestrator. The fixed
 * union is the single source of truth for the Review Dashboard
 * to render.
 */
export const LINT_FINDING_KINDS = [
  "wildcard_bindings",
  "stale_pages",
  "orphans",
  "prompt_version_drift",
  "contradictions",
  "automation_drift",
] as const;
export type LintFindingKind = (typeof LINT_FINDING_KINDS)[number];

export const LINT_FINDING_SCHEMA = z
  .object({
    kind: z.enum(LINT_FINDING_KINDS),
    severity: z.enum(["low", "medium", "high"]),
    /** Free-form scope description — for wildcard_bindings it's
     *  the binding id; for stale_pages it's the wiki path. The
     *  Review Dashboard renders this as the row title. */
    scope: z.string().min(1),
    message: z.string().min(1),
    /** Per-kind detail blob — citations, related ids, etc.
     *  Detectors are free to put what they need here; the
     *  Review Dashboard renders verbatim. */
    detail: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const LINT_OUTPUT_SCHEMA = z
  .object({
    version: z.literal("v1"),
    findings: z.array(LINT_FINDING_SCHEMA),
  })
  .strict();

export type LintFinding = z.infer<typeof LINT_FINDING_SCHEMA>;
export type LintOutput = z.infer<typeof LINT_OUTPUT_SCHEMA>;

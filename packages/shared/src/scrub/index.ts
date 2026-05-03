/**
 * `@opencoo/shared/scrub` — credential-scrubbing utilities.
 *
 * Exports:
 *   - `scrubPat` — pattern-based credential redaction for error
 *     strings (THREAT-MODEL §3.6 invariant 11).
 *   - `safeErrorMessage` + `ERROR_MESSAGE_MAX_LENGTH` — coerce
 *     unknown → string, scrub, then cap at 200 chars. The single
 *     source of truth for the scrub-and-cap pattern previously
 *     duplicated as inline `safeError(...)` helpers across five
 *     sites (PR-P3 consolidation, phase-a appendix #8).
 */
export { scrubPat } from "./pat-scrub.js";
export { ERROR_MESSAGE_MAX_LENGTH, safeErrorMessage } from "./safe-error.js";

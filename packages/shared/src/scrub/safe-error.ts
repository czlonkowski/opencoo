/**
 * `safeErrorMessage` — coerce-and-scrub-and-cap helper for error
 * strings that flow into structured-log payloads.
 *
 * The single source of truth for the scrub-and-cap pattern
 * previously duplicated as `safeError(...)` across five sites
 * (PR-N3 / PR-O2 / PR-O3 reviewer feedback; PR-P3 consolidation):
 *
 *   - packages/cli/src/provision/production-composition.ts
 *   - packages/cli/src/commands/agents-fire.ts
 *   - packages/engine-ingestion/src/workers/production-context.ts
 *   - packages/engine-self-operating/src/start.ts
 *   - packages/adapters/automation-n8n-mcp/src/list-templates.ts
 *
 * # Order matters
 *
 * Scrub FIRST, then cap. Cap-then-scrub would leave credential
 * bytes that straddle the 200-char boundary unredacted because
 * the regex would no longer match the truncated form (e.g. a
 * 36-char token sliced at byte 5 yields a 5-char fragment that
 * trips no scrub pattern). Every previous inline duplicate
 * preserved scrub-then-cap; preserve it here.
 *
 * # Input handling
 *
 *   - Error instance → uses `.message` (subclass-friendly: an
 *     OpencooError's `.errorClass` taxonomy field is ignored)
 *   - string → uses verbatim
 *   - anything else → `String(value)` (POJO becomes
 *     "[object Object]"; null becomes "null"; etc.)
 *
 * # Threat-model anchor
 *
 * THREAT-MODEL §2 invariant 11 + §3.6 invariant 11: no credential
 * bytes in error logs. This helper is the universal exit gate for
 * `Error.message` strings before they leave the engine process via
 * the logger.
 */
import { scrubPat } from "./pat-scrub.js";

/** Maximum length of an error message AFTER scrub. Caps log noise +
 *  ensures even a future verifier that emits a 10 KB stack trace
 *  doesn't blow up structured-log payloads. The previous five
 *  inline duplicates all used 200; the value was reviewer-validated
 *  multiple times and is the contract for downstream callers. */
export const ERROR_MESSAGE_MAX_LENGTH = 200;

/** Scrub credential patterns from an error's message + cap at
 *  `ERROR_MESSAGE_MAX_LENGTH` chars for logging. See module
 *  docblock for input-handling and order rationale. Pure; never
 *  throws. */
export function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return scrubPat(raw).slice(0, ERROR_MESSAGE_MAX_LENGTH);
}

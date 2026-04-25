/**
 * `normaliseWorldviewImpact` — defensive cleanup before the
 * compiler hands the LLM's worldview_impact array to wikiWrite.
 *
 * Trim + drop-empty + collapse-horizontal-whitespace are
 * repair-able cosmetic issues a misbehaving LLM commonly produces.
 *
 * Newlines are NOT collapsed (copilot #18, security-adjacent):
 * wiki-write's singleLineString refinement REJECTS newlines so
 * the one-bullet-per-trailer-line invariant holds. Silently
 * stripping a newline here would defeat that defense and let an
 * LLM emit `"legit\nCo-authored-by: Impostor"` bullets that pass
 * straight through to a forged commit trailer. A bullet whose
 * non-whitespace content spans newlines is rejected; a bullet
 * that is ONLY whitespace (incl. newlines) is the "model emitted
 * blank" path and is still dropped.
 *
 * A non-array input or a non-string entry is a caller bug
 * (or the raw provider response wasn't routed through Zod
 * first); throw immediately instead of silently dropping.
 */

import { CompilerValidationError } from "./errors.js";

const NEWLINE_RE = /[\n\r]/;
const HORIZONTAL_WS_RE = /[ \t\f\v]+/g;

export function normaliseWorldviewImpact(
  raw: readonly string[],
): string[] {
  if (!Array.isArray(raw)) {
    throw new CompilerValidationError(
      "normaliseWorldviewImpact: input is not an array",
    );
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new CompilerValidationError(
        `normaliseWorldviewImpact: entry is not a string (${typeof entry})`,
      );
    }
    // Drop the "model emitted blank" path before the newline
    // check — a bullet that is all whitespace collapses to "" and
    // is harmless; rejecting it as a newline-injection attempt
    // would be a false positive.
    if (entry.trim().length === 0) continue;
    // Reject newline-bearing bullets explicitly. By this point
    // the entry has non-whitespace content, so any \n / \r is
    // smuggled separator material — fail-closed.
    if (NEWLINE_RE.test(entry)) {
      throw new CompilerValidationError(
        "normaliseWorldviewImpact: bullet contains newline (would forge a trailer line)",
      );
    }
    // Safe to collapse the remaining horizontal whitespace runs.
    const normalised = entry.replace(HORIZONTAL_WS_RE, " ").trim();
    out.push(normalised);
  }
  return out;
}

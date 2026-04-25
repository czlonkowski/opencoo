/**
 * `normaliseWorldviewImpact` — defensive cleanup before the
 * compiler hands the LLM's worldview_impact array to wikiWrite.
 *
 * Trim + drop-empty + collapse-whitespace are repair-able
 * cosmetic issues a misbehaving LLM commonly produces. Truly
 * malformed input (true newline that survives whitespace
 * collapse, length > 200 after trim) propagates so wikiWrite
 * throws the typed input error and the orchestrator DLQs.
 *
 * A non-array input or a non-string entry is a caller bug
 * (or the raw provider response wasn't routed through Zod
 * first); throw immediately instead of silently dropping.
 */

import { CompilerValidationError } from "./errors.js";

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
    // Collapse all whitespace runs (incl. tabs, newlines) to a
    // single space, then trim. A bullet that was just "  \n  "
    // collapses to "" and is dropped.
    const normalised = entry.replace(/\s+/g, " ").trim();
    if (normalised.length === 0) continue;
    out.push(normalised);
  }
  return out;
}

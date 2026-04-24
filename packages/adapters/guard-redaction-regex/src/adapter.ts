/**
 * Regex-based GuardAdapter (role: redaction). Pure-function classify;
 * no DB writes (engine handles persistence per CONVENTIONS §4.1). Each
 * `classify()` call is independent state — no cache, no shared mutable
 * data — so two parallel callers do not interfere.
 *
 * Match pipeline:
 *   1. Build the UTF-8 byte-offset map ONCE for the whole input.
 *   2. For each pattern in PATTERNS, run `regex.exec` from the start
 *      of the string, advancing `lastIndex` between hits.
 *   3. Run optional `validate` on the candidate substring; rejection
 *      drops the match entirely (no event, no transform).
 *   4. Resolve overlap: keep the LONGEST match per byte range; ties
 *      broken by category-name alphabetical order.
 *   5. Sort surviving matches by start offset.
 *   6. Build `transformedText` by replacing each match with
 *      `[REDACTED:<category>]` (left-to-right).
 *   7. Build the `events` array — metadata only, no content.
 *
 * The adapter is sync at heart but `classify()` is async (per port
 * contract — future LLM-backed guards need it). The Promise wrapper
 * is the only async surface.
 */
import type {
  GuardAdapter,
  GuardClassifyInput,
  GuardClassifyResult,
  GuardEvent,
  GuardFailMode,
} from "@opencoo/shared/adapter-contract-tests/guard";

import { PATTERNS, CATEGORIES, type PatternDef } from "./patterns.js";
import { buildByteOffsetMap, codeUnitsToBytes } from "./utf8-bytes.js";

/**
 * Sortable string version. Date-stamped so `WHERE pattern_version >=
 * 'v1.2026-04-25'` audit-log scans are linear, with `v1.` prefix so
 * a future v2 catalog (different patterns, different validators) sorts
 * after the entire v1 lineage.
 */
export const PATTERN_VERSION = "v1.2026-04-25";

const ADAPTER_SLUG = "guard-redaction-regex";

/** @internal — exported only for `_resolveOverlap` unit tests. */
export interface RawMatch {
  readonly category: string;
  readonly failMode: GuardFailMode;
  /** Code-unit offsets from RegExp.exec, used to compute byte
   *  offsets via the prefix map. */
  readonly startCu: number;
  readonly endCu: number;
}

function findRawMatches(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  // Iterate as the widened PatternDef so optional `validate` is
  // accessible uniformly. Frozen array semantics from `as const`
  // still hold at runtime; we just trade narrow per-entry types for
  // a uniform iteration shape here.
  const patterns: ReadonlyArray<PatternDef> = PATTERNS;
  for (const pattern of patterns) {
    const re = new RegExp(pattern.regex.source, pattern.regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const matchedText = m[0];
      // Empty-match guard against pathological zero-width regex
      // shapes; if a pattern ever matched zero bytes it would loop
      // forever otherwise.
      if (matchedText.length === 0) {
        re.lastIndex++;
        continue;
      }
      if (pattern.validate !== undefined && !pattern.validate(matchedText)) {
        continue;
      }
      out.push({
        category: pattern.category,
        failMode: pattern.failMode,
        startCu: m.index,
        endCu: m.index + matchedText.length,
      });
    }
  }
  return out;
}

/**
 * Resolve overlapping matches deterministically:
 * - Sort by start ascending; on tie, longer match first; on tie,
 *   alphabetical category order.
 * - Walk and drop any candidate whose start is < the previous
 *   accepted match's end.
 *
 * This produces a non-overlapping LONGEST-MATCH set so the
 * transformedText replacement is unambiguous and idempotent.
 *
 * @internal — exported only for unit testing.
 */
export function _resolveOverlap(raw: RawMatch[]): RawMatch[] {
  const sorted = [...raw].sort((a, b) => {
    if (a.startCu !== b.startCu) return a.startCu - b.startCu;
    const aLen = a.endCu - a.startCu;
    const bLen = b.endCu - b.startCu;
    if (aLen !== bLen) return bLen - aLen; // longer first on tie
    return a.category < b.category ? -1 : a.category > b.category ? 1 : 0;
  });
  const out: RawMatch[] = [];
  let cursor = 0;
  for (const m of sorted) {
    if (m.startCu < cursor) continue;
    out.push(m);
    cursor = m.endCu;
  }
  return out;
}

function applyTransform(text: string, matches: readonly RawMatch[]): string {
  if (matches.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.startCu > cursor) {
      parts.push(text.slice(cursor, m.startCu));
    }
    parts.push(`[REDACTED:${m.category}]`);
    cursor = m.endCu;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts.join("");
}

class RegexRedactionGuard implements GuardAdapter {
  readonly slug = ADAPTER_SLUG;
  readonly role = "redaction" as const;
  readonly categories = CATEGORIES;
  readonly patternVersion = PATTERN_VERSION;

  async classify(input: GuardClassifyInput): Promise<GuardClassifyResult> {
    const { text } = input;
    if (text.length === 0) {
      return { events: [], transformedText: "" };
    }

    const raw = findRawMatches(text);
    const resolved = _resolveOverlap(raw);
    const byteMap = buildByteOffsetMap(text);

    const events: GuardEvent[] = resolved.map((m) => {
      const range = codeUnitsToBytes(byteMap, m.startCu, m.endCu);
      // METADATA ONLY — DO NOT add any field that carries the matched
      // substring (THREAT-MODEL §3.3). The pattern-author who reaches
      // for "let's also include `matched: string`" should fail code
      // review here AND fail the contract suite's sentinel test.
      return {
        category: m.category,
        patternVersion: PATTERN_VERSION,
        matchedByteRanges: [range],
        failMode: m.failMode,
      };
    });

    const transformedText = applyTransform(text, resolved);
    return { events, transformedText };
  }
}

/**
 * Factory. Mirrors converterDocling() / giteaWikiAdapter() shape — a
 * single zero-arg call returns a fresh-but-stateless instance.
 */
export function guardRedactionRegex(): GuardAdapter {
  return new RegexRedactionGuard();
}

// Re-export types/constants needed by patterns.ts consumers.
export type { PatternDef };

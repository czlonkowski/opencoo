/**
 * Reusable contract suite for the `GuardAdapter` port (THREAT-MODEL
 * §3.3). Every guard backend — the regex-redaction adapter today, an
 * LLM injection-classifier next, a content-safety scanner after that —
 * runs this exact 12-assertion matrix so the boundary stays
 * port-faithful across all of them.
 *
 * The METADATA-ONLY invariant is the lynchpin of the suite. Assertion 7
 * passes a known sentinel substring inside the matched text and proves
 * `JSON.stringify(events)` does NOT contain that sentinel. If a future
 * adapter starts logging match content into the event surface (even
 * "for debugging"), this test fails immediately.
 *
 * Why the contract lives in `@opencoo/shared`:
 *
 * - The schema (`redaction_events` table, `guard_fail_mode` enum) is in
 *   shared; the contract sits next to its source of truth.
 * - Adapter packages depend on `@opencoo/shared` already, so importing
 *   the suite costs zero dependency surface.
 * - One contract → all guards. Drift in any backend breaks all
 *   simultaneously.
 *
 * Pass-through invariants the suite locks (per Correction A from
 * PR-12 + THREAT-MODEL §3.3):
 *
 * - `GuardClassifyInput` is `{ text: string }` only. Pipeline /
 *   domainId / bindingId belong on the engine-side `redaction_events`
 *   row, not on the adapter port.
 * - For `role: 'redaction'`: `transformedText` is the input with
 *   matches replaced (per the adapter's transform policy — the
 *   suite checks "transform happened", not the exact token).
 * - For non-redaction roles: `transformedText === input.text`.
 * - Events are metadata-only. No content, no original text, no diff.
 */
import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Port shapes
// ---------------------------------------------------------------------------

/**
 * Three guard roles, mirroring the architecture spec. The engine routes
 * based on this discriminant: redaction guards mutate `transformedText`
 * in place; injection / content_safety guards only score.
 */
export type GuardRole = "injection" | "content_safety" | "redaction";

/**
 * Mirrors the `guard_fail_mode` pgEnum byte-for-byte. If the schema
 * grows a value, this type and the engine that consumes it must move
 * together.
 */
export type GuardFailMode = "block" | "transform" | "review";

/**
 * The input the adapter sees. JUST text. The engine knows pipeline /
 * domainId / bindingId at the call site and stamps those onto
 * `redaction_events` rows when persisting. Adapters are leaves
 * (CONVENTIONS §4.1) and must not know their caller's context.
 */
export interface GuardClassifyInput {
  readonly text: string;
}

/**
 * Per-match metadata. THREAT-MODEL §3.3: NO content. Reviewers go back
 * to the source system to see what triggered a match — they do NOT
 * read it out of `redaction_events`.
 */
export interface GuardEvent {
  /** Pattern category, e.g. "email", "pesel", "aws-access-key". */
  readonly category: string;
  /** Adapter's `patternVersion` constant at the time of match. */
  readonly patternVersion: string;
  /** Byte offsets into the input text. UTF-8 multi-byte characters
   *  count for their byte width, not their codepoint width. */
  readonly matchedByteRanges: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
  }>;
  /** Disposition the engine should apply for this category — the
   *  adapter chooses based on its config; the engine honours it. */
  readonly failMode: GuardFailMode;
}

export interface GuardClassifyResult {
  readonly events: ReadonlyArray<GuardEvent>;
  /**
   * For `role: 'redaction'`: input with matches replaced (token shape
   * is adapter-defined; the suite checks "transform happened" not
   * exact text). For non-redaction roles: identical to input.text.
   */
  readonly transformedText: string;
}

export interface GuardAdapter {
  /** Stable slug used for `redaction_events.guard_slug` lookup. */
  readonly slug: string;
  /** Routing discriminant. The engine selects guards by role. */
  readonly role: GuardRole;
  /** All categories the adapter MIGHT emit — used by the engine to
   *  validate per-domain "hide this category" filters before the
   *  guard runs. */
  readonly categories: ReadonlyArray<string>;
  /** Stamped on every event. Sortable string is preferred over
   *  semver so audit log scans `WHERE pattern_version >= 'v1.2026-…'`
   *  are linear. */
  readonly patternVersion: string;
  classify(input: GuardClassifyInput): Promise<GuardClassifyResult>;
}

// ---------------------------------------------------------------------------
// Contract fixtures
// ---------------------------------------------------------------------------

/**
 * One concrete known-good positive sample. Each adapter contributes a
 * batch of these covering its own categories. The suite uses each entry
 * to drive assertions 6 (single-match), 7 (metadata-only sentinel), 10
 * (UTF-8 byte ranges).
 */
export interface KnownMatch {
  readonly category: string;
  /** A standalone sample that contains exactly one match of `category`
   *  and no other matches from the adapter's catalog. */
  readonly sample: string;
  /** Byte offsets the adapter MUST report for `sample`. Computed by
   *  the test author up-front so the suite catches off-by-one errors. */
  readonly expectedByteRanges: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
  }>;
  /** A substring of `sample` that — by construction — would leak
   *  matched content if the adapter incorrectly stuffed match data
   *  into the event surface. Pick something distinctive (a unique
   *  numeric suffix, a fixture-only label) so accidental coincidences
   *  with category names don't false-positive. */
  readonly sentinel: string;
}

export interface GuardAdapterFixtureOptions {
  /** Shows up in describe titles for diagnostics. */
  readonly backendName: string;
  /** Returns a fresh adapter per test. Adapters are stateless per
   *  classify() so a singleton works, but the factory is the standard
   *  shape for parity with other contract suites. */
  readonly makeAdapter: () => GuardAdapter;
  /** Per-category positive samples. Each entry is exercised by
   *  assertions 6, 7, 10. */
  readonly knownMatches: ReadonlyArray<KnownMatch>;
  /** A clean string the adapter MUST NOT match anywhere. Used by
   *  assertion 5 (no-match identity). */
  readonly noMatchSample: string;
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

const REDACTION_TOKEN_RE = /\[REDACTED:[a-z0-9-]+\]/i;

export function guardAdapterContract(
  options: GuardAdapterFixtureOptions,
): void {
  describe(`guardAdapterContract / ${options.backendName}`, () => {
    // 1. Slug + role basics.
    it("declares a non-empty slug and a valid GuardRole", () => {
      const a = options.makeAdapter();
      expect(typeof a.slug).toBe("string");
      expect(a.slug.length).toBeGreaterThan(0);
      expect(["injection", "content_safety", "redaction"]).toContain(a.role);
    });

    // 2. Categories non-empty.
    it("declares at least one category", () => {
      const a = options.makeAdapter();
      expect(Array.isArray(a.categories)).toBe(true);
      expect(a.categories.length).toBeGreaterThan(0);
    });

    // 3. patternVersion is a non-empty string.
    it("declares a non-empty patternVersion", () => {
      const a = options.makeAdapter();
      expect(typeof a.patternVersion).toBe("string");
      expect(a.patternVersion.length).toBeGreaterThan(0);
    });

    // 4. Empty input → empty events + identity transformedText.
    it("returns empty events for empty text", async () => {
      const a = options.makeAdapter();
      const r = await a.classify({ text: "" });
      expect(r.events).toEqual([]);
      expect(r.transformedText).toBe("");
    });

    // 5. No-match input → events:[] and transformedText == input.text.
    it("returns empty events and identity transformedText when nothing matches", async () => {
      const a = options.makeAdapter();
      const r = await a.classify({ text: options.noMatchSample });
      expect(r.events).toEqual([]);
      expect(r.transformedText).toBe(options.noMatchSample);
    });

    // 6. Each known match: exactly one event with correct category +
    //    byte ranges. patternVersion must echo the adapter's value.
    for (const match of options.knownMatches) {
      it(`matches a known ${match.category} sample at the expected byte ranges`, async () => {
        const a = options.makeAdapter();
        const r = await a.classify({ text: match.sample });
        const inCategory = r.events.filter(
          (e) => e.category === match.category,
        );
        expect(inCategory).toHaveLength(1);
        const event = inCategory[0]!;
        expect(event.patternVersion).toBe(a.patternVersion);
        expect(event.matchedByteRanges).toEqual(match.expectedByteRanges);
        // failMode is one of the three pgEnum values.
        expect(["block", "transform", "review"]).toContain(event.failMode);
      });
    }

    // 7. METADATA-ONLY SENTINEL — the lynchpin (THREAT-MODEL §3.3).
    //    Loop through each known match: the sentinel substring inside
    //    `sample` MUST NOT appear anywhere in `JSON.stringify(events)`.
    //    If it does, an adapter is leaking matched content into the
    //    event surface — fail loud, do not merge.
    for (const match of options.knownMatches) {
      it(`metadata-only invariant: ${match.category} events MUST NOT contain the sample's sentinel substring`, async () => {
        const a = options.makeAdapter();
        const r = await a.classify({ text: match.sample });
        // Sanity: the sentinel actually IS in the input — otherwise
        // the test would silently pass on every adapter regardless
        // of behaviour.
        expect(match.sample).toContain(match.sentinel);
        // The actual invariant.
        const serialised = JSON.stringify(r.events);
        expect(serialised).not.toContain(match.sentinel);
      });
    }

    // 8. Multi-match input: events sorted by `matchedByteRanges[0].start`
    //    in ascending order so engine-side replacement loops can rely
    //    on a stable iteration order.
    it("sorts events by their first byte-range start (ascending)", async () => {
      // Build a synthetic combined text by concatenating two known
      // samples with a separator. Adapter must report both, sorted.
      if (options.knownMatches.length < 2) return;
      const a = options.makeAdapter();
      const m1 = options.knownMatches[0]!;
      const m2 = options.knownMatches[1]!;
      const sep = "\n---\n";
      const combined = `${m1.sample}${sep}${m2.sample}`;
      const r = await a.classify({ text: combined });
      // Filter to the two categories under test (other patterns
      // might incidentally fire too — sort assertion is per the
      // FULL events list).
      const byStart = [...r.events].map((e) => {
        const first = e.matchedByteRanges[0];
        return first ? first.start : -1;
      });
      const sorted = [...byStart].sort((x, y) => x - y);
      expect(byStart).toEqual(sorted);
    });

    // 9. UTF-8 multi-byte: byte ranges count BYTES, not codepoints.
    //    Synthesize a sample with a multi-byte prefix and verify the
    //    reported `start` accounts for it.
    it("reports byte offsets in UTF-8 byte units, not codepoint units", async () => {
      if (options.knownMatches.length === 0) return;
      const a = options.makeAdapter();
      const match = options.knownMatches[0]!;
      // 4 codepoints (each 3 bytes in UTF-8 for these CJK chars) =
      // 12-byte prefix. We pick CJK because it's unambiguously
      // multi-byte and unlikely to overlap any guard pattern.
      const prefix = "你好你好"; // 12 bytes
      const text = `${prefix}${match.sample}`;
      const r = await a.classify({ text });
      const inCategory = r.events.filter((e) => e.category === match.category);
      expect(inCategory).toHaveLength(1);
      const event = inCategory[0]!;
      const expected = match.expectedByteRanges.map((br) => ({
        start: br.start + 12,
        end: br.end + 12,
      }));
      expect(event.matchedByteRanges).toEqual(expected);
    });

    // 10. transformedText behaviour by role.
    it("transformedText replaces matches for redaction role; identity for non-redaction", async () => {
      if (options.knownMatches.length === 0) return;
      const a = options.makeAdapter();
      const match = options.knownMatches[0]!;
      const r = await a.classify({ text: match.sample });
      if (a.role === "redaction") {
        // The matched substring must NOT appear in transformedText
        // verbatim (the very point of redaction). The adapter is
        // free to choose its replacement token shape; the suite
        // doesn't dictate exact bytes.
        expect(r.transformedText).not.toBe(match.sample);
        // Belt-and-suspenders: the original sentinel substring
        // shouldn't survive in the transformed text either.
        expect(r.transformedText).not.toContain(match.sentinel);
      } else {
        expect(r.transformedText).toBe(match.sample);
      }
    });

    // 11. Stateless: two consecutive calls with the SAME input return
    //     equivalent results (no shared mutable state across calls).
    it("classify is stateless — two consecutive calls produce equivalent results", async () => {
      if (options.knownMatches.length === 0) return;
      const a = options.makeAdapter();
      const match = options.knownMatches[0]!;
      const r1 = await a.classify({ text: match.sample });
      const r2 = await a.classify({ text: match.sample });
      // Deep-equal: events list + transformedText.
      expect(r2.transformedText).toBe(r1.transformedText);
      expect(JSON.stringify(r2.events)).toBe(JSON.stringify(r1.events));
    });

    // 12. Idempotent under transform: re-classifying the transformed
    //     text from a redaction guard yields zero events for the same
    //     categories (the redaction token does not re-match). This
    //     locks the rule "redaction tokens are inert under future
    //     pattern matches" — critical to prevent infinite-loop
    //     redaction in the engine.
    it("redaction transform is idempotent — re-classifying transformedText yields no new matches in the same categories", async () => {
      if (options.knownMatches.length === 0) return;
      const a = options.makeAdapter();
      if (a.role !== "redaction") return;
      const match = options.knownMatches[0]!;
      const r1 = await a.classify({ text: match.sample });
      // Sanity-check that the redaction token shape is at least
      // recognisably bracket-prefixed; if the adapter chose
      // something exotic (no brackets), this assertion still
      // passes — we only assert IDEMPOTENCE, not the token shape.
      // (The bracket pattern is a heuristic for the failure-mode
      // assertion below.)
      expect(REDACTION_TOKEN_RE.test(r1.transformedText) || r1.transformedText === "").toBe(
        r1.events.length > 0 || r1.transformedText === "",
      );
      const r2 = await a.classify({ text: r1.transformedText });
      const sameCategoryAgain = r2.events.filter(
        (e) => e.category === match.category,
      );
      expect(sameCategoryAgain).toHaveLength(0);
    });
  });
}

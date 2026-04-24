/**
 * (copilot #14 Fix 4) — the contract suite's sort-order assertion
 * (assertion 8) was `matchedByteRanges[0]?.start ?? -1`, which
 * silently passed events with EMPTY range arrays AND would have
 * masked events whose first range had invalid bounds (start >= end,
 * end > byteLength).
 *
 * The fix exposes a named `validateEventRanges` helper from the
 * contract module and wires it into assertion 8 BEFORE the
 * sort-order check. This file pins the helper's behaviour
 * independently of the assertion that uses it, plus drives the
 * full suite against a well-formed stub to confirm legitimate
 * adapters still pass.
 */
import { describe, it, expect } from "vitest";

import {
  guardAdapterContract,
  validateEventRanges,
  type GuardAdapter,
  type GuardClassifyInput,
  type GuardClassifyResult,
} from "../src/adapter-contract-tests/guard.js";

describe("guardAdapterContract — validateEventRanges (Fix 4)", () => {
  it("rejects events with empty matchedByteRanges", () => {
    const result = validateEventRanges(
      [
        {
          category: "x",
          patternVersion: "v",
          matchedByteRanges: [],
          failMode: "transform",
        },
      ],
      100,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects events with inverted bounds (start >= end)", () => {
    const result = validateEventRanges(
      [
        {
          category: "x",
          patternVersion: "v",
          matchedByteRanges: [{ start: 10, end: 10 }],
          failMode: "transform",
        },
      ],
      100,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects events whose end exceeds the input byte length", () => {
    const result = validateEventRanges(
      [
        {
          category: "x",
          patternVersion: "v",
          matchedByteRanges: [{ start: 0, end: 200 }],
          failMode: "transform",
        },
      ],
      100,
    );
    expect(result.ok).toBe(false);
  });

  it("accepts well-formed events", () => {
    const result = validateEventRanges(
      [
        {
          category: "x",
          patternVersion: "v",
          matchedByteRanges: [{ start: 0, end: 50 }],
          failMode: "transform",
        },
      ],
      100,
    );
    expect(result.ok).toBe(true);
  });
});

// --- Well-formed stub satisfies the FULL suite under the tighter
//     validation. If the validation over-tightens, this surfaces it.

class StubWellFormed implements GuardAdapter {
  readonly slug = "stub-well-formed";
  readonly role = "redaction" as const;
  readonly categories = ["good"];
  readonly patternVersion = "v1.test";

  async classify(input: GuardClassifyInput): Promise<GuardClassifyResult> {
    const ranges: { start: number; end: number }[] = [];
    let cursor = 0;
    let scan = "";
    const re = /TARGET-[0-9]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input.text)) !== null) {
      const startCu = m.index;
      const endCu = m.index + m[0].length;
      const startB = Buffer.byteLength(input.text.slice(0, startCu), "utf8");
      const endB = Buffer.byteLength(input.text.slice(0, endCu), "utf8");
      ranges.push({ start: startB, end: endB });
      scan += input.text.slice(cursor, startCu) + "[good]";
      cursor = endCu;
    }
    return {
      events: ranges.map((r) => ({
        category: "good",
        patternVersion: this.patternVersion,
        matchedByteRanges: [r],
        failMode: "transform" as const,
      })),
      transformedText: ranges.length > 0 ? scan + input.text.slice(cursor) : input.text,
    };
  }
}

guardAdapterContract({
  backendName: "stub-well-formed",
  makeAdapter: () => new StubWellFormed(),
  noMatchSample: "no targets here",
  knownMatches: [
    {
      category: "good",
      sample: "before TARGET-7421 after",
      // 'TARGET-7421' starts at byte 7, ends at byte 18.
      expectedByteRanges: [{ start: 7, end: 18 }],
      sentinel: "TARGET-7421",
    },
  ],
});

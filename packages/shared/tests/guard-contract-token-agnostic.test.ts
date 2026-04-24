/**
 * (copilot #14 Fix 3) — the guardAdapterContract idempotence
 * assertion must be agnostic to the adapter's redaction-token shape.
 * The contract used to assert `[REDACTED:<category>]` (bracket-
 * prefixed) which means an adapter that chose `<<HIDDEN>>`, `█████`,
 * or empty-string would fail an assertion that should be irrelevant
 * to it.
 *
 * Drives the contract suite with a stub adapter whose transform token
 * is `<<HIDDEN>>`. If the suite still couples to the bracket shape,
 * the idempotence assertion fails. The real assertion — "re-classifying
 * transformedText yields zero same-category events" — is exercised
 * by the stub honouring its own transform.
 */
import { describe, it, expect } from "vitest";

import {
  guardAdapterContract,
  type GuardAdapter,
  type GuardClassifyInput,
  type GuardClassifyResult,
} from "../src/adapter-contract-tests/guard.js";

const STUB_PATTERN = /SECRET-[A-Z0-9]{8}/g;

class StubGuardWithCustomToken implements GuardAdapter {
  readonly slug = "stub-custom-token";
  readonly role = "redaction" as const;
  readonly categories = ["secret"];
  readonly patternVersion = "v1.test";

  async classify(input: GuardClassifyInput): Promise<GuardClassifyResult> {
    const ranges: { start: number; end: number }[] = [];
    let transformed = input.text;
    // Single-pass scan: collect byte ranges + replace with the
    // intentionally-non-bracket token.
    let scan = "";
    let cursor = 0;
    let match: RegExpExecArray | null;
    const re = new RegExp(STUB_PATTERN.source, STUB_PATTERN.flags);
    while ((match = re.exec(input.text)) !== null) {
      const start = match.index;
      const end = match.index + match[0].length;
      ranges.push({ start, end });
      scan += input.text.slice(cursor, start) + "<<HIDDEN>>";
      cursor = end;
    }
    if (ranges.length > 0) {
      transformed = scan + input.text.slice(cursor);
    }
    return {
      events: ranges.map((r) => ({
        category: "secret",
        patternVersion: this.patternVersion,
        matchedByteRanges: [r],
        failMode: "transform" as const,
      })),
      transformedText: transformed,
    };
  }
}

guardAdapterContract({
  backendName: "stub-custom-token-shape",
  makeAdapter: () => new StubGuardWithCustomToken(),
  noMatchSample: "no secrets here",
  knownMatches: [
    {
      category: "secret",
      sample: "before SECRET-ABCD1234 after",
      // 'SECRET-ABCD1234' starts at byte 7, ends at byte 22.
      expectedByteRanges: [{ start: 7, end: 22 }],
      sentinel: "ABCD1234",
    },
  ],
});

describe("guardAdapterContract — Fix 3 sanity", () => {
  it("a custom-token-shape stub satisfies the contract suite", async () => {
    // Belt-and-suspenders: verify the stub's token shape ISN'T
    // accidentally bracket-prefixed (in which case the test below
    // would tautologically pass). The stub's transform uses
    // `<<HIDDEN>>` which intentionally has no `[REDACTED:...]`
    // brackets.
    const a = new StubGuardWithCustomToken();
    const r = await a.classify({ text: "before SECRET-ABCD1234 after" });
    expect(r.transformedText).toContain("<<HIDDEN>>");
    expect(r.transformedText).not.toMatch(/\[REDACTED/);
  });
});

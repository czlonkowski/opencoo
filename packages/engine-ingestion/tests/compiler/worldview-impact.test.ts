/**
 * `normaliseWorldviewImpact` — defensive cleanup before the
 * compiler hands the LLM's worldview_impact array to wikiWrite.
 *
 * The Zod schema in @opencoo/shared/wiki-write rejects newlines
 * and >200 chars per entry, but a misbehaving LLM commonly sends
 * leading/trailing whitespace or empty strings; we trim + drop
 * those rather than DLQ the whole compile run for a cosmetic
 * issue.
 *
 * Anything that cannot be safely repaired (true newline, ≥200
 * chars after trim) propagates so wikiWrite throws the typed
 * input error and the orchestrator DLQs.
 */
import { describe, expect, it } from "vitest";

import { normaliseWorldviewImpact } from "../../src/compiler/worldview-impact.js";

describe("normaliseWorldviewImpact — pass-through cases", () => {
  it("returns clean strings unchanged", () => {
    const input = ["bullet one", "bullet two", "bullet three"];
    expect(normaliseWorldviewImpact(input)).toEqual(input);
  });

  it("returns [] for empty input", () => {
    expect(normaliseWorldviewImpact([])).toEqual([]);
  });
});

describe("normaliseWorldviewImpact — defensive cleanup", () => {
  it("trims leading + trailing whitespace from every entry", () => {
    expect(
      normaliseWorldviewImpact(["  bullet one  ", "\tbullet two\t"]),
    ).toEqual(["bullet one", "bullet two"]);
  });

  it("drops entries that are empty or whitespace-only after trim", () => {
    expect(
      normaliseWorldviewImpact(["bullet", "", "   ", "\t\n", "bullet 2"]),
    ).toEqual(["bullet", "bullet 2"]);
  });

  it("collapses internal runs of horizontal whitespace to a single space", () => {
    // A model that emits "bullet   one\twith\ttabs" should not
    // surface a tab-laden trailer line. Newlines are NOT collapsed
    // here — they're a security signal (see the next describe block).
    expect(normaliseWorldviewImpact(["bullet   one\twith\ttabs"])).toEqual([
      "bullet one with tabs",
    ]);
  });

  it("preserves non-ASCII characters (PL prompts emit Polish)", () => {
    expect(
      normaliseWorldviewImpact(["priorytet dystrybucji się zmienił"]),
    ).toEqual(["priorytet dystrybucji się zmienił"]);
  });
});

describe("normaliseWorldviewImpact — newline rejection (copilot #18)", () => {
  // wiki-write's singleLineString refinement rejects newlines in
  // worldviewImpact entries so the one-bullet-per-trailer-line
  // invariant holds. Silently stripping newlines here would defeat
  // that defense — e.g. an LLM emitting "legit\nCo-authored-by:
  // Impostor" would have its forged trailer pre-stripped before
  // wiki-write got a chance to reject. Rejecting at this layer
  // sends the run to DLQ, which is the correct fail-closed action.

  it("rejects a bullet containing \\n (LF)", () => {
    expect(() =>
      normaliseWorldviewImpact(["legit one\nlegit two"]),
    ).toThrow();
  });

  it("rejects a bullet containing \\r (CR)", () => {
    expect(() =>
      normaliseWorldviewImpact(["legit one\rlegit two"]),
    ).toThrow();
  });

  it("rejects a bullet containing CRLF", () => {
    expect(() =>
      normaliseWorldviewImpact(["legit one\r\nCo-authored-by: Impostor <x@x>"]),
    ).toThrow();
  });

  it("still drops a whitespace-only-LF bullet (treated as empty, not as injected newline)", () => {
    // A bullet that is ONLY whitespace (incl. newlines) reduces to
    // empty after trim — this is the "model emitted blank" path,
    // not the injection path; drop quietly.
    expect(normaliseWorldviewImpact(["bullet", "\n", "  \n  "])).toEqual([
      "bullet",
    ]);
  });
});

describe("normaliseWorldviewImpact — non-string handling", () => {
  it("throws when input is not an array", () => {
    expect(() =>
      normaliseWorldviewImpact("not an array" as unknown as string[]),
    ).toThrow();
  });

  it("throws when an entry is not a string (Zod boundary)", () => {
    expect(() =>
      normaliseWorldviewImpact([
        "ok",
        42 as unknown as string,
      ]),
    ).toThrow();
  });
});

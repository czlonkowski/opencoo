/**
 * Shape-lock for `@opencoo/shared/adapter-contract-tests/guard`.
 *
 * The contract is the GuardAdapter port from THREAT-MODEL §3.3:
 * stateless per `classify()`, metadata-only events, role-based
 * routing (`injection | content_safety | redaction`).
 *
 * This file does NOT invoke the suite — it only locks the module's
 * exported shape so adapter packages can rely on what they import.
 * The 12 assertions the generator runs are documented inside the
 * suite itself.
 */
import { describe, it, expect } from "vitest";

import {
  guardAdapterContract,
  type GuardAdapter,
  type GuardClassifyInput,
  type GuardClassifyResult,
  type GuardEvent,
  type GuardFailMode,
  type GuardRole,
  type GuardAdapterFixtureOptions,
} from "../src/adapter-contract-tests/guard.js";

describe("adapter-contract-tests/guard — module shape", () => {
  it("exports guardAdapterContract as a function", () => {
    expect(typeof guardAdapterContract).toBe("function");
  });

  it("GuardRole is one of three values", () => {
    const r1: GuardRole = "injection";
    const r2: GuardRole = "content_safety";
    const r3: GuardRole = "redaction";
    expect([r1, r2, r3]).toEqual(["injection", "content_safety", "redaction"]);
  });

  it("GuardFailMode mirrors the guard_fail_mode pgEnum (block | transform | review)", () => {
    const f1: GuardFailMode = "block";
    const f2: GuardFailMode = "transform";
    const f3: GuardFailMode = "review";
    expect([f1, f2, f3]).toEqual(["block", "transform", "review"]);
  });

  it("GuardClassifyInput contains text only (Correction A — no pipeline/domainId/bindingId)", () => {
    // Compile-time check: only `text` is allowed. Adding any field
    // here drifts the port from the engine-side wrapper that adds
    // pipeline/domainId/bindingId at the call site (CONVENTIONS §4.1).
    const input: GuardClassifyInput = { text: "hello" };
    expect(input.text).toBe("hello");
  });

  it("GuardEvent is metadata-only (no `matched` / `text` / content fields)", () => {
    // Compile-time stub: the only fields that can be filled are the
    // four metadata fields. THREAT-MODEL §3.3: the matched content
    // itself MUST never appear in events.
    const event: GuardEvent = {
      category: "email",
      patternVersion: "v1.2026-04-25",
      matchedByteRanges: [{ start: 0, end: 5 }],
      failMode: "transform",
    };
    expect(event.category).toBe("email");
  });

  it("GuardAdapter + fixture types compile against a stub", () => {
    // Type-only smoke: a stub matching the interface compiles. Drift
    // in any field surfaces here.
    const stub: GuardAdapter = {
      slug: "test",
      role: "redaction",
      categories: ["test"],
      patternVersion: "v1.2026-04-25",
      async classify(input: GuardClassifyInput): Promise<GuardClassifyResult> {
        return { events: [], transformedText: input.text };
      },
    };
    const fixture: GuardAdapterFixtureOptions = {
      backendName: "stub",
      makeAdapter: () => stub,
      knownMatches: [
        {
          category: "test",
          sample: "hello",
          expectedByteRanges: [{ start: 0, end: 5 }],
          // Sentinel string the suite asserts MUST NOT leak into
          // any event field — the metadata-only invariant.
          sentinel: "hello",
        },
      ],
    };
    expect(stub.slug).toBe("test");
    expect(fixture.backendName).toBe("stub");
  });
});

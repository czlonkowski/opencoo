/**
 * Worldview debounce policy tests (PR 22 / plan #106 Q5).
 *
 * Approved interpretation: escalating delay by event count
 *   - 1 event → never (gate; single signal isn't enough)
 *   - 2 events → 15-minute delay from firstAt
 *   - 3 events → 3-hour delay from firstAt
 *   - 4+ events → 24-hour delay from firstAt
 *
 * `syntheticHighImpact` (Lint contradiction severity='error')
 * counts as 2 events — the orchestrator pre-doubles before
 * calling the policy, so the policy itself only sees the
 * effective count.
 */
import { describe, expect, it } from "vitest";

import {
  DEBOUNCE_DELAY_2_EVENTS_MS,
  DEBOUNCE_DELAY_3_EVENTS_MS,
  DEBOUNCE_DELAY_4_PLUS_EVENTS_MS,
  decideWorldviewDebounce,
} from "../../../src/pipelines/worldview/index.js";

const FIRST_AT = 1_000_000;

describe("decideWorldviewDebounce", () => {
  it("1 event → never", () => {
    const decision = decideWorldviewDebounce({
      effectiveEventCount: 1,
      firstAtMs: FIRST_AT,
      nowMs: FIRST_AT + 1_000,
    });
    expect(decision).toEqual({ kind: "never" });
  });

  it("0 events → never (no signal at all)", () => {
    const decision = decideWorldviewDebounce({
      effectiveEventCount: 0,
      firstAtMs: FIRST_AT,
      nowMs: FIRST_AT,
    });
    expect(decision).toEqual({ kind: "never" });
  });

  it("2 events at firstAt → 15-minute delay", () => {
    const decision = decideWorldviewDebounce({
      effectiveEventCount: 2,
      firstAtMs: FIRST_AT,
      nowMs: FIRST_AT,
    });
    expect(decision).toEqual({
      kind: "compile",
      afterMs: DEBOUNCE_DELAY_2_EVENTS_MS,
    });
  });

  it("3 events at firstAt → 3-hour delay", () => {
    const decision = decideWorldviewDebounce({
      effectiveEventCount: 3,
      firstAtMs: FIRST_AT,
      nowMs: FIRST_AT,
    });
    expect(decision).toEqual({
      kind: "compile",
      afterMs: DEBOUNCE_DELAY_3_EVENTS_MS,
    });
  });

  it("4 events at firstAt → 24-hour delay", () => {
    const decision = decideWorldviewDebounce({
      effectiveEventCount: 4,
      firstAtMs: FIRST_AT,
      nowMs: FIRST_AT,
    });
    expect(decision).toEqual({
      kind: "compile",
      afterMs: DEBOUNCE_DELAY_4_PLUS_EVENTS_MS,
    });
  });

  it("10 events at firstAt → 24-hour delay (4+ bucket)", () => {
    const decision = decideWorldviewDebounce({
      effectiveEventCount: 10,
      firstAtMs: FIRST_AT,
      nowMs: FIRST_AT,
    });
    expect(decision).toEqual({
      kind: "compile",
      afterMs: DEBOUNCE_DELAY_4_PLUS_EVENTS_MS,
    });
  });

  it("2 events with elapsed > 15min → afterMs=0 (overdue, run now)", () => {
    const decision = decideWorldviewDebounce({
      effectiveEventCount: 2,
      firstAtMs: FIRST_AT,
      nowMs: FIRST_AT + DEBOUNCE_DELAY_2_EVENTS_MS + 1,
    });
    expect(decision).toEqual({ kind: "compile", afterMs: 0 });
  });

  it("3 events partway through delay → afterMs is remaining", () => {
    const elapsed = 30 * 60_000; // 30 minutes
    const decision = decideWorldviewDebounce({
      effectiveEventCount: 3,
      firstAtMs: FIRST_AT,
      nowMs: FIRST_AT + elapsed,
    });
    expect(decision).toEqual({
      kind: "compile",
      afterMs: DEBOUNCE_DELAY_3_EVENTS_MS - elapsed,
    });
  });

  it("syntheticHighImpact pre-doubling: 1 high-impact = effective 2 → 15min", () => {
    // Orchestrator's responsibility: turn 1 syntheticHighImpact
    // into effectiveEventCount=2 before calling the policy.
    // The policy itself sees only the effective count.
    const decision = decideWorldviewDebounce({
      effectiveEventCount: 2,
      firstAtMs: FIRST_AT,
      nowMs: FIRST_AT,
    });
    expect(decision.kind).toBe("compile");
  });
});

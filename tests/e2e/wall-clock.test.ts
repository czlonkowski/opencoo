/**
 * Wall-clock budget guard (PR 32 / plan #149 decision Q13).
 *
 * The phase-a ship-gate e2e suite is sized at <10 min wall-
 * clock; planner sized the actual work at ~7.5 min, leaving
 * ~2.5 min of headroom. This meta-test asserts the suite
 * actually completes inside the budget — a regression that
 * silently exceeds the budget (e.g. compose pull thrashing,
 * a pathological retry loop) is the failure mode this catches.
 *
 * The test runs LAST in the suite alphabetically (filename
 * suffix `wall-clock`) AND the vitest config uses
 * `singleFork=true` so all e2e files execute serially in the
 * same process. By the time we get here, every other e2e file
 * has already finished, so `process.uptime()` is the suite's
 * cumulative wall-clock — including compose bring-up, all
 * three tests, and any inter-test reset.
 *
 * No service interaction; this test runs even if Docker is not
 * available — the guard is on the suite total, not on a
 * per-test latency.
 */
import { describe, it, expect } from "vitest";

const BUDGET_MS = 10 * 60 * 1000; // 10 min

describe("e2e suite wall-clock", () => {
  it(`completes in under ${BUDGET_MS / 1000 / 60} min total`, () => {
    const elapsedMs = Math.round(process.uptime() * 1000);
    expect(
      elapsedMs,
      `e2e suite exceeded the ${BUDGET_MS / 1000}s wall-clock budget at ${elapsedMs}ms — investigate compose bring-up, retry loops, or the test that pushed past the headroom`,
    ).toBeLessThan(BUDGET_MS);
  });
});

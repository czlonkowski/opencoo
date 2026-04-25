/**
 * Worldview debounce policy (PR 22 / plan #106 Q5,
 * architecture §9).
 *
 * Escalating delay by event count since `firstAt`:
 *   - 1 event → never (single event isn't enough signal)
 *   - 2 events → 15-minute delay from firstAt
 *   - 3 events → 3-hour delay from firstAt
 *   - 4+ events → 24-hour delay from firstAt
 *
 * `syntheticHighImpact` (Lint contradiction with severity='error')
 * counts as 2 events — i.e. one such event is enough to trigger
 * a 15-minute compile (skips the never-solo gate).
 *
 * Pure function over (effective event count, firstAt, now). The
 * orchestrator owns the queue + is responsible for marshalling
 * raw events + synthetic-impact tags into the call.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

export const DEBOUNCE_DELAY_2_EVENTS_MS = 15 * MS_PER_MINUTE;
export const DEBOUNCE_DELAY_3_EVENTS_MS = 3 * MS_PER_HOUR;
export const DEBOUNCE_DELAY_4_PLUS_EVENTS_MS = 24 * MS_PER_HOUR;

export type WorldviewDebounceDecision =
  | { readonly kind: "never" }
  | { readonly kind: "compile"; readonly afterMs: number };

export interface WorldviewDebounceArgs {
  /** Total events since `firstAt`. A `syntheticHighImpact`
   *  contributes 2 to this count; the orchestrator pre-doubles
   *  before calling. */
  readonly effectiveEventCount: number;
  /** Wall-clock ms when the first event in the current window
   *  arrived. The output `afterMs` is a delay from this point,
   *  not from `now`. */
  readonly firstAtMs: number;
  /** Current wall-clock ms. */
  readonly nowMs: number;
}

export function decideWorldviewDebounce(
  args: WorldviewDebounceArgs,
): WorldviewDebounceDecision {
  const count = args.effectiveEventCount;
  if (count <= 1) {
    return { kind: "never" };
  }
  let delayMs: number;
  if (count === 2) delayMs = DEBOUNCE_DELAY_2_EVENTS_MS;
  else if (count === 3) delayMs = DEBOUNCE_DELAY_3_EVENTS_MS;
  else delayMs = DEBOUNCE_DELAY_4_PLUS_EVENTS_MS;
  const elapsed = args.nowMs - args.firstAtMs;
  // Caller passes `firstAt` from the persisted queue; if elapsed
  // already exceeds the delay, the compile is overdue and runs
  // now (afterMs: 0).
  const afterMs = Math.max(0, delayMs - elapsed);
  return { kind: "compile", afterMs };
}

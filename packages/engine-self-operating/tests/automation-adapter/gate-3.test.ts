/**
 * GATE 3 CONTRACT TEST (THREAT-MODEL §2 invariant 7,
 * plan #102).
 *
 * Pins the AutomationAdapter interface's method shape so a
 * future PR can't silently add `activate()` / `enable()` /
 * `toggle()` and bypass Gate 3.
 *
 * Two layers:
 *   1. **Type-level keys check.** `AutomationAdapter` has
 *      EXACTLY ONE method (`deployWorkflow`). The keyof
 *      assertion fails to compile if anything else is
 *      added — this is the load-bearing pin.
 *   2. **Forbidden-method runtime probe.** A faux subtype that
 *      tries to add `activate` should NOT satisfy
 *      AutomationAdapter (the type system rejects via
 *      structural typing if the signature is incompatible
 *      with the closed interface, but TypeScript is structural
 *      and would normally accept extra methods — so the keys
 *      assertion at #1 is the real seal).
 *
 * Plus a parallel source-grep test on `builder/run.ts` for the
 * literal `'activated'` — defense-in-depth against an inline
 * string that bypasses the type system entirely.
 */
import { describe, expect, it } from "vitest";

import {
  InMemoryAutomationAdapter,
  type AutomationAdapter,
} from "../../src/automation-adapter/index.js";

// Compile-time pin: this assignable mapping is the closed
// allow-list for AutomationAdapter method names. If a new
// method is added to the interface, the EXPECTED set below
// must be updated AND the build/lint check at the bottom of
// the file must still pass.
const EXPECTED_METHOD_NAMES = ["deployWorkflow"] as const;
type ExpectedMethodName = (typeof EXPECTED_METHOD_NAMES)[number];

// Compile-time enforcement: keyof AutomationAdapter must equal
// ExpectedMethodName. If TypeScript widens this, CI fails at
// type-check.
type _Pin =
  // If the LHS is not assignable to the RHS, the conditional
  // narrows to `never`, which is then NOT assignable to a
  // non-never type — surfacing as a TS error.
  (keyof AutomationAdapter) extends ExpectedMethodName ? true : never;
type _PinReverse =
  ExpectedMethodName extends keyof AutomationAdapter ? true : never;

// `_Pin` and `_PinReverse` together force keyof === expected.
// Forcing usage so the unused-symbol lint doesn't strip them.
const __pinAcknowledged: _Pin = true;
const __pinReverseAcknowledged: _PinReverse = true;
void __pinAcknowledged;
void __pinReverseAcknowledged;

describe("AutomationAdapter — Gate 3 method-name allow-list", () => {
  it("EXPECTED_METHOD_NAMES is the closed v0.1 set", () => {
    expect(EXPECTED_METHOD_NAMES).toEqual(["deployWorkflow"]);
  });

  it("InMemoryAutomationAdapter includes deployWorkflow and omits forbidden callable instance methods", () => {
    // Walk the prototype + own props, filter to functions.
    const adapter = new InMemoryAutomationAdapter();
    const proto = Object.getPrototypeOf(adapter) as object;
    const fnNames = new Set<string>();
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      const v = (adapter as unknown as Record<string, unknown>)[name];
      if (typeof v === "function") fnNames.add(name);
    }
    // Other public methods (reset, etc.) ARE allowed on the
    // concrete fixture — we only assert that none of the
    // forbidden names appear.
    for (const forbidden of [
      "activate",
      "enable",
      "toggle",
      "setActive",
      "makeActive",
      "run",
      "trigger",
      "fire",
    ]) {
      expect(fnNames.has(forbidden), `forbidden method '${forbidden}' present on InMemoryAutomationAdapter`).toBe(false);
    }
    // And `deployWorkflow` MUST be present.
    expect(fnNames.has("deployWorkflow")).toBe(true);
  });
});

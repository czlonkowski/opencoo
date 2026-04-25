/**
 * GATE 3 SOURCE-GREP TEST (plan #102 / THREAT-MODEL §2 invariant 7).
 *
 * Defense-in-depth on top of the type-level + schema-level
 * Gate 3 enforcements:
 *   - Type level: AutomationAdapter has no `activate()` method.
 *   - Schema level: BuilderOutput has no `activated` field.
 *   - **This file**: source of `builder/run.ts` does NOT contain
 *     the literal `'activated'` (case-insensitive). Catches the
 *     case where someone bypasses the type system via an inline
 *     SQL string, a fetch() call, or any other escape hatch.
 *
 * The test reads `builder/run.ts` from disk and runs a regex.
 * Failing this test means a future PR introduced a string that
 * suggests activation — STOP and review before approving.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILDER_RUN_PATH = resolve(
  HERE,
  "../../src/agents/builder/run.ts",
);

describe("Gate 3 source-grep — builder/run.ts (plan #102)", () => {
  it("does NOT contain the literal 'activated' (case-insensitive)", () => {
    const source = readFileSync(BUILDER_RUN_PATH, "utf8");
    // Strip comments — they may legitimately reference Gate 3
    // by name (e.g. "manual activation only"). We only forbid
    // the literal in CODE.
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(codeOnly.toLowerCase()).not.toMatch(/activate(d)?|enable(d)?|toggle(d)?/);
  });

  it("does contain the legitimate 'deployWorkflow' adapter call (sanity)", () => {
    const source = readFileSync(BUILDER_RUN_PATH, "utf8");
    expect(source).toContain("deployWorkflow");
  });
});

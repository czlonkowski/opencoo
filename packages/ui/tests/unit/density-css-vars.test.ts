/**
 * Density CSS-variable sweep — PR-C6, phase-a appendix #16 wave-16.
 *
 * Parses `colors_and_type.css` and pins:
 *   1. Each density-scoped spacing var defined under `:root` has a
 *      corresponding override under `body[data-density="compact"]`.
 *   2. Compact values are SMALLER (in pixels) than the comfortable
 *      defaults. A future edit that accidentally widens compact past
 *      comfortable would invert the toggle and is caught here.
 *
 * Source-level parsing only — no jsdom, no React. The fence is at
 * the CSS file because the design-system tokens are the SoT (the
 * Btn / Table / CommandPalette consumers read them via `var(--…)`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CSS_PATH = resolve(
  __dirname,
  "../../src/styles/colors_and_type.css",
);

const SOURCE = readFileSync(CSS_PATH, "utf-8");

/** Density-scoped variables the toggle relies on. Adding a new
 *  density-aware token? Add it here AND to the compact override
 *  block in `colors_and_type.css`. */
const DENSITY_VARS = [
  "--row-pad-y",
  "--row-pad-x",
  "--table-cell-pad-y",
  "--table-cell-pad-x",
  "--micro-label-tracking",
] as const;

/** Extract the value of `--name` from the body of a CSS block.
 *  Returns null if the var isn't declared in the block. */
function readVar(block: string, name: string): string | null {
  // Anchor on the var name followed by `:`; capture up to the next
  // semicolon. Tolerates whitespace.
  const re = new RegExp(`${name}\\s*:\\s*([^;\\n}]+);`);
  const m = re.exec(block);
  if (m === null) return null;
  return (m[1] ?? "").trim();
}

/** Extract a single CSS block body matched by a selector header.
 *  Lazy match — finds the first `selector { … }`. Sufficient because
 *  each selector appears exactly once in the file. */
function readBlock(selector: string): string {
  // Match `selector` then non-greedy capture between the first `{`
  // and its matching `}` (the file has no nested blocks under
  // either of the two selectors we read, so a flat brace match is
  // safe).
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`);
  const m = re.exec(SOURCE);
  if (m === null) {
    throw new Error(
      `density-css-vars.test: selector ${selector} not found in colors_and_type.css`,
    );
  }
  return m[1] ?? "";
}

/** Parse a px value or em value into a comparable number. For
 *  multi-component values ("4px 6px") returns the FIRST component —
 *  the test treats the y-component as the canonical comparison
 *  point, matching how rows are usually felt (vertical breathing
 *  room dominates). */
function toComparablePx(value: string): number {
  // First numeric token followed by unit.
  const m = /(-?\d+(?:\.\d+)?)(px|em|rem)?/.exec(value);
  if (m === null) {
    throw new Error(
      `density-css-vars.test: cannot parse value "${value}" to a comparable number`,
    );
  }
  return Number(m[1]);
}

describe("Density-scoped CSS vars (PR-C6)", () => {
  it("declares every density var on :root", () => {
    const rootBlock = readBlock(":root");
    const missing: string[] = [];
    for (const name of DENSITY_VARS) {
      if (readVar(rootBlock, name) === null) missing.push(name);
    }
    expect(
      missing,
      `:root is missing density vars: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("declares every density var under body[data-density='compact']", () => {
    const compactBlock = readBlock('body[data-density="compact"]');
    const missing: string[] = [];
    for (const name of DENSITY_VARS) {
      if (readVar(compactBlock, name) === null) missing.push(name);
    }
    expect(
      missing,
      `body[data-density="compact"] is missing density vars: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("compact spacing values are smaller than the comfortable defaults", () => {
    const rootBlock = readBlock(":root");
    const compactBlock = readBlock('body[data-density="compact"]');
    const violations: string[] = [];
    // Only the spacing vars are directly comparable as "smaller =
    // tighter". Micro-label tracking is tracked separately because
    // its unit (em) is a typographic feel, not a spacing feel.
    const SPACING_VARS = [
      "--row-pad-y",
      "--row-pad-x",
      "--table-cell-pad-y",
      "--table-cell-pad-x",
    ] as const;
    for (const name of SPACING_VARS) {
      const comfortable = readVar(rootBlock, name);
      const compact = readVar(compactBlock, name);
      if (comfortable === null || compact === null) continue;
      const cVal = toComparablePx(comfortable);
      const compactVal = toComparablePx(compact);
      if (compactVal >= cVal) {
        violations.push(
          `${name}: compact=${compact} >= comfortable=${comfortable}`,
        );
      }
    }
    expect(
      violations,
      `compact mode should TIGHTEN spacing:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("compact micro-label tracking is <= comfortable tracking", () => {
    // Compact mode SHOULD compress letter-spacing a touch (or at
    // least not loosen it) so the chrome reads denser. Equality is
    // allowed — comfort floor of 0.08em is already tight.
    const rootBlock = readBlock(":root");
    const compactBlock = readBlock('body[data-density="compact"]');
    const comfortable = readVar(rootBlock, "--micro-label-tracking");
    const compact = readVar(compactBlock, "--micro-label-tracking");
    if (comfortable === null || compact === null) {
      // Earlier test already pins the existence of both — short-
      // circuit here keeps the message specific.
      return;
    }
    const cVal = toComparablePx(comfortable);
    const compactVal = toComparablePx(compact);
    expect(compactVal).toBeLessThanOrEqual(cVal);
  });

  it("does not introduce any CSS transition on the density attribute (one-loop rule)", () => {
    // The design-system "exactly one loop" invariant — density swap
    // is INSTANT, no transition. A drive-by edit that adds
    // `transition: ... data-density ...` (or any transition under
    // the compact block) would re-introduce motion.
    const compactBlock = readBlock('body[data-density="compact"]');
    expect(/transition\s*:/i.test(compactBlock)).toBe(false);
    expect(/animation\s*:/i.test(compactBlock)).toBe(false);
  });
});

/**
 * Btn hover affordances — PR-C5 (wave-16, phase-a appendix #16).
 *
 * Pins the uniform hover recipe:
 *   - Every variant renders with the `opencoo-hover-btn` class so
 *     `app.css` can attach a `:hover` rule to it. We also pin a
 *     per-variant `data-variant=…` attribute so the css can fork
 *     per variant without re-introducing color literals.
 *   - The hover transition is declared in `app.css` and references
 *     ONLY `background-color` + `border-color`. No `transform`, no
 *     `box-shadow`, no `transition: all`.
 *   - Disabled buttons opt out of the hover class so the recipe
 *     can't activate against `cursor: not-allowed`.
 *
 * The CSS-rule shape is asserted by parsing `app.css` directly —
 * jsdom doesn't compute `:hover` styles, so we read the source.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { Btn } from "../../src/components/Btn.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_CSS = readFileSync(
  resolve(__dirname, "../../src/styles/app.css"),
  "utf-8",
);

describe("Btn — hover class application", () => {
  it("attaches the opencoo-hover-btn class on the primary variant", () => {
    const { container } = render(<Btn>Click</Btn>);
    const btn = container.querySelector("button") as HTMLButtonElement;
    expect(btn.className).toContain("opencoo-hover-btn");
    expect(btn.getAttribute("data-variant")).toBe("primary");
  });

  it("attaches the hover class + data-variant on every variant", () => {
    for (const v of ["primary", "ghost", "advisory", "subtle"] as const) {
      const { container, unmount } = render(<Btn variant={v}>x</Btn>);
      const btn = container.querySelector("button") as HTMLButtonElement;
      expect(btn.className).toContain("opencoo-hover-btn");
      expect(btn.getAttribute("data-variant")).toBe(v);
      unmount();
    }
  });

  it("omits the hover class when disabled (cursor: not-allowed)", () => {
    const { container } = render(<Btn disabled>x</Btn>);
    const btn = container.querySelector("button") as HTMLButtonElement;
    expect(btn.className).not.toContain("opencoo-hover-btn");
  });
});

describe("Btn — CSS recipe (parsed from app.css)", () => {
  it("declares :hover for opencoo-hover-btn with explicit per-property transitions", () => {
    const rule = extractRuleBlock(APP_CSS, ".opencoo-hover-btn");
    expect(rule).not.toBeNull();
    // Transition mentions background-color + border-color, nothing else.
    expect(rule).toMatch(/transition:\s*[^;]*background-color[^;]*/);
    expect(rule).toMatch(/transition:\s*[^;]*border-color[^;]*/);
    // No transition: all anywhere on this class.
    expect(rule).not.toMatch(/transition:\s*all\b/);
    // No transform / box-shadow listed as transition properties.
    // The negative-lookahead variant rules out `transform` standalone
    // while permitting `var(--ease-transform)` (the easing token).
    expect(rule).not.toMatch(/transition:[^;]*\btransform\s*[,;\n]/);
    expect(rule).not.toMatch(/transition:[^;]*\bbox-shadow\b/);
    // Uses the design-system easing token + 60ms.
    expect(rule).toMatch(/60ms\s+var\(--ease-transform\)/);
  });

  it("declares per-variant :hover background-color shifts using design tokens", () => {
    // Each variant gets its own :hover rule that references a CSS
    // variable (paper / ink / advisory / rule) — no hex literals
    // anywhere in the C5 hover recipe.
    for (const v of ["primary", "ghost", "advisory", "subtle"]) {
      const sel = `.opencoo-hover-btn[data-variant="${v}"]:hover`;
      const block = extractRuleBlock(APP_CSS, sel);
      expect(block, `missing :hover for ${v}`).not.toBeNull();
      // Must reference a design-system var, never a hex literal.
      expect(block).toMatch(/var\(--[a-z0-9-]+\)/);
      expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});

/**
 * Extract the body of the FIRST CSS rule whose selector matches
 * `selector` literally. Returns null when not found.
 */
function extractRuleBlock(css: string, selector: string): string | null {
  const idx = css.indexOf(selector);
  if (idx < 0) return null;
  const open = css.indexOf("{", idx);
  if (open < 0) return null;
  // Find the matching closing brace at the same depth.
  let depth = 1;
  for (let i = open + 1; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

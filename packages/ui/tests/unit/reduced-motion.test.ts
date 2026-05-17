/**
 * Reduced-motion gate — PR-C5 (wave-16, phase-a appendix #16).
 *
 * The design-system reserves exactly one motion loop — the
 * heartbeat-pulse on the operate glyph. C5 adds a global
 * `prefers-reduced-motion: reduce` rule in `colors_and_type.css`
 * that clamps every transition (including B5 saving-cue, B7
 * toast mount/dismiss, C5 hover) to ≤80ms, satisfying the
 * wave-end gate (appendix #16, verification step 4).
 *
 * jsdom cannot evaluate `@media` at-rules so we assert the rule
 * is present in the stylesheet source.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const COLORS_CSS = readFileSync(
  resolve(__dirname, "../../src/styles/colors_and_type.css"),
  "utf-8",
);

describe("colors_and_type.css — prefers-reduced-motion clamp", () => {
  it("declares a `prefers-reduced-motion: reduce` media query", () => {
    expect(COLORS_CSS).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  it("clamps transition-duration globally inside the reduce block", () => {
    const block = extractMediaBlock(
      COLORS_CSS,
      "@media (prefers-reduced-motion: reduce)",
    );
    expect(block, "missing reduced-motion media block").not.toBeNull();
    // The clamp targets `*` (or `*, *::before, *::after`).
    // `transition-duration: <…>ms !important` must appear.
    expect(block).toMatch(/transition-duration:\s*0?\.?\d+m?s\s*!important/);
  });

  it("clamps animation-duration as well so the heartbeat steps to one-shot", () => {
    // The wave-end gate (appendix #16 verification step 4) says
    // "verify heartbeat-pulse stops (or steps to one-shot)". Clamping
    // animation-duration to ~0ms in the reduce block achieves the
    // "steps to one-shot" branch — the loop keeps running but each
    // frame is instantaneous, which renders as a static glyph.
    const block = extractMediaBlock(
      COLORS_CSS,
      "@media (prefers-reduced-motion: reduce)",
    );
    expect(block).toMatch(/animation-duration:\s*0?\.?\d+m?s\s*!important/);
  });
});

/**
 * Extract the body of the FIRST `@media` block whose selector
 * matches `header` literally. Returns null when not found.
 */
function extractMediaBlock(css: string, header: string): string | null {
  const idx = css.indexOf(header);
  if (idx < 0) return null;
  const open = css.indexOf("{", idx);
  if (open < 0) return null;
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

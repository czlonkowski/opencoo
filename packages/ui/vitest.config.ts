import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Vitest config — JSDOM environment for component tests; the
 * Playwright e2e suite runs separately via `pnpm test:e2e`.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    include: [
      "tests/unit/**/*.test.{ts,tsx}",
      // PR-B2 (wave-16) — bundle-size fence lives under tests/ui/.
      // That file uses a per-file `// @vitest-environment node`
      // directive to override jsdom; jsdom can't read fs/zlib.
      "tests/ui/**/*.test.{ts,tsx}",
      // PR-A6 (wave-16) — the WCAG color-contrast sweep fence lives
      // under `tests/accessibility/`. Source-level CSS parsing only
      // (no jsdom needed), but kept under vitest so a `pnpm test`
      // run at the package root catches drifts.
      "tests/accessibility/**/*.test.{ts,tsx}",
      // PR-C7 (wave-16) — the cross-route visual-consistency snapshot
      // sits at `tests/visual-consistency.test.tsx` (alongside the
      // unit/ui/e2e subtrees). Picked up by an explicit glob rather
      // than promoting `tests/*.test.tsx` so future top-level files
      // are an opt-in surface.
      "tests/visual-consistency.test.tsx",
    ],
    setupFiles: ["./tests/unit/setup.ts"],
    testTimeout: 15_000,
  },
});

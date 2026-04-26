/**
 * Phase-a e2e ship-gate vitest config (PR 32 / plan #149).
 *
 * Single-fork serial execution (`singleFork: true`) so:
 *   1. Every e2e file shares ONE compose stack — bringing it
 *      up + tearing it down per file would blow the 10-min
 *      wall-clock budget.
 *   2. The wall-clock guard meta-test (`wall-clock.test.ts`)
 *      can read `process.uptime()` and assert against the
 *      WHOLE suite's cumulative time. Multi-fork would split
 *      the timeline.
 *   3. Per-test reset (`resetForTest`) is straightforward —
 *      no inter-fork synchronisation needed.
 *
 * `testTimeout` 600s covers the worst-case healthcheck-stretch
 * + slow-network compose pull on a CI runner. Local runs
 * typically finish each test in <60s.
 *
 * The default `pnpm test` regression run MUST NOT pull this
 * suite in — `vitest.config.ts` excludes `tests/e2e/**`.
 * `pnpm test:e2e` is the only entrypoint.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/e2e/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    testTimeout: 600_000,
    hookTimeout: 600_000,
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});

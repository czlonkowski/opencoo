/**
 * Live-pilot regression-test vitest config (PR-Q14, phase-a
 * appendix #9).
 *
 * Single-fork serial execution + 10-minute test timeout — same
 * shape as `vitest.e2e.config.ts` because the live-pilot test
 * shares the e2e compose lifecycle (postgres + redis + gitea via
 * `compose.e2e.yml`).
 *
 * The default `pnpm test` regression run MUST NOT pull this
 * suite in — `vitest.config.ts` excludes `tests/live-pilot.*`.
 * `pnpm test:live-pilot` is the only entrypoint; CI fires it
 * nightly via `.github/workflows/nightly-live-pilot.yml`.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/live-pilot.real-pg.test.ts"],
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

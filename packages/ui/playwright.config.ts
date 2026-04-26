/**
 * Playwright config (PR 29 / plan #131, decision Q9 — separate
 * `e2e` tag; runs on PR + main only).
 *
 * The e2e suite is intentionally minimal in v0.1 — the UI is
 * use-case-tested via Vitest + JSDOM, and the live browser
 * smoke test lands in PR 32 ("phase-a e2e: ingest-to-wiki +
 * Heartbeat + forget"). This config exists so the `test:e2e`
 * script wires when an operator (or CI) runs it locally with
 * a Chromium binary installed.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
});

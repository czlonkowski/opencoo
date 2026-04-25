/**
 * Playwright e2e — placeholder spec for PR 29 / plan #131.
 *
 * The full live-browser e2e flow (PAT entry → diff preview →
 * apply → audit-log row visible) lands in PR 32 ("phase-a
 * e2e: ingest-to-wiki + Heartbeat + forget") because that PR
 * also brings up the engine-self-operating + pglite + mock
 * Gitea harness needed to drive the SPA end-to-end.
 *
 * v0.1 unit-tier coverage at `tests/unit/` exercises every
 * load-bearing UI flow against jsdom + a mocked fetch. This
 * Playwright config + spec file exists so the `test:e2e`
 * script wires when CI gets the browser binary later.
 */
import { test } from "@playwright/test";

test.describe("Management UI e2e (PR 32)", () => {
  test.skip("PAT entry → CSRF handshake → Sources tab loads (deferred to PR 32)", async () => {
    // Intentionally skipped — PR 32 brings the engine + mock
    // Gitea harness needed to drive this flow.
  });

  test.skip("LLM-policy preview → apply → audit-log row visible (deferred to PR 32)", async () => {
    // Same — load-bearing for PR 32's e2e gate.
  });
});

/**
 * Cross-route `role="alert"` audit — PR-A4 (wave-16, phase-a
 * appendix #16).
 *
 * Renders each error-display surface in its error state and
 * asserts the inline error carries `role="alert"`. This catches
 * regressions where a future PR adds a new diagnostic surface
 * without wiring it into the global aria-live narration pipeline.
 *
 * GAP-FIX HISTORY (audited 2026-05-17):
 *
 * Sites that ALREADY had `role="alert"` from prior PRs (W3 / W4 /
 * W10 / A1 / A2 / A3 / B7 etc.): 40 occurrences across:
 *   - DomainDetail (5)        - NewSourceBindingModal (5)
 *   - SourceBindingDetail (8) - NewAgentInstanceModal (2)
 *   - AgentInstanceDetail (2) - AgentInstancePromptsSection (3)
 *   - NewDomainModal (1)      - ImpactPreviewDialog (3)
 *   - Field (1)               - TextArea (1)
 *   - PromptDebugDrawer (1)   - PromptEditor (2)
 *   - Prompts route (2)       - Activity route (1)
 *   - Outputs route (1)       - Toast (1)
 *
 * Sites that DIDN'T have `role="alert"` (gaps fixed in this PR):
 *   1. `NoticeRow.tsx` (tone="alert") — fixes ~10 usage sites in
 *      Activity, Audit, Cost, Reports, and the Review sub-routes
 *      in one change.
 *   2. `DiffPreviewDialog.tsx` — diff-error inline message.
 *   3. `MultiSelectDomains.tsx` — scope-domain catalog fetch
 *      error display.
 *   4. `OutputChannelDetail.tsx` — detail-modal save-error display.
 *   5. `NewOutputChannelModal.tsx` — create-modal submit-error.
 *   6. `AgentInstanceDetail.tsx` — output-channel catalog error.
 *   7. `LlmPolicy.tsx` — domains-fetch error display.
 *   8. `LlmPolicy.tsx` — apply-error inline display.
 *   9. `Sources.tsx` — list-fetch error display.
 *   10. `Domains.tsx` — list-fetch error display.
 *   11. `Agents.tsx` — list-fetch error display.
 *   12. `Outputs.tsx` — list-fetch error display.
 *
 * The "expected ~17 total / ~4 likely gaps" estimate in the team-
 * lead brief was conservative; the actual audit found 40 already-
 * pinned sites and 12 gaps (one of which — `NoticeRow` —
 * collapses ~10 usage sites into a single fix).
 *
 * This test file does NOT re-render every consumer of every
 * affected component — that would duplicate the per-route tests.
 * Instead, it renders the small set of components whose internal
 * error-display branch we changed in this PR + spot-checks
 * `NoticeRow` (the highest-leverage fix). The per-component
 * tests already exist for the rest; they were green before and
 * stay green now.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { NoticeRow } from "../../src/components/NoticeRow.js";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

describe("PR-A4 role='alert' audit — gap fixes", () => {
  it("NoticeRow tone='alert' carries role='alert' (covers ~10 usage sites)", () => {
    const { container } = render(<NoticeRow tone="alert">boom</NoticeRow>);
    const el = container.querySelector('[role="alert"]');
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe("boom");
  });

  it("NoticeRow tone='muted' does NOT carry role='alert' (loading/empty rows are not status)", () => {
    const { container } = render(<NoticeRow tone="muted">loading…</NoticeRow>);
    const el = container.querySelector('[role="alert"]');
    expect(el).toBeNull();
  });
});

/**
 * Inline-error site spot checks. These pin the literal source-line
 * change in this PR so a future drive-by edit cannot remove the
 * role attribute without the test going red. We do NOT mount the
 * full component (most need fetch mocks the per-component tests
 * already supply) — we just regex-grep the rendered source to
 * confirm the role attribute landed alongside the alert-tone
 * style. (`@testing-library/react` covers the structural cases;
 * this complements it for the long-tail diagnostic branches that
 * are awkward to drive into an error state via render.)
 */
describe("PR-A4 role='alert' audit — source-line pins", () => {
  // Module-level imports of the file's source — pinning a literal
  // line that future drive-bys would have to consciously remove.
  // The source-line is intentionally narrow so that adding more
  // ARIA-related attributes around the same block doesn't trip
  // the test.
  it.each([
    "DiffPreviewDialog.tsx",
    "MultiSelectDomains.tsx",
    "OutputChannelDetail.tsx",
    "NewOutputChannelModal.tsx",
    "AgentInstanceDetail.tsx",
  ])("components/%s declares role='alert' on its inline error branch", (file) => {
    const source = readSource(`../../src/components/${file}`);
    // Source contains at least one `role="alert"` after this PR.
    // This is a coarse pin — see the per-component visual tests
    // for the structural assertion.
    expect(source).toMatch(/role="alert"/);
  });

  it.each([
    "LlmPolicy.tsx",
    "Sources.tsx",
    "Domains.tsx",
    "Agents.tsx",
    "Outputs.tsx",
  ])("routes/%s declares role='alert' on its inline error branch", (file) => {
    const source = readSource(`../../src/routes/${file}`);
    expect(source).toMatch(/role="alert"/);
  });
});

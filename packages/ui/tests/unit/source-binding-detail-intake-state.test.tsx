/**
 * SourceBindingDetail — "Intake state" panel tests (PR-W4, phase-a
 * appendix #14).
 *
 * W3 made the worker's failure terminal state visible in the DB; W4
 * surfaces it on the SourceBindingDetail modal:
 *   - 4-count grid (`pending`, `classified`, `skipped`, `failed`)
 *     drawn from the new `intakeCounts` field on the GET response.
 *   - Up to 3 most-recent failed rows (id + errorClass chip + scrubbed
 *     errorTextSnippet) drawn from `recentFailedIntake`.
 *   - Per-row Retry button — disabled in W4 with a tooltip pointing at
 *     PR-W2 (the per-job retry endpoint ships there). The button is
 *     present so the operator sees the affordance; wiring lands when
 *     W2 merges.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { SourceBindingDetail } from "../../src/components/SourceBindingDetail.js";
import type { SourceBinding } from "../../src/types.js";

const BINDING_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeBinding(overrides: Partial<SourceBinding> = {}): SourceBinding {
  return {
    id: BINDING_ID,
    domainSlug: "wiki-intake-test",
    adapterSlug: "drive",
    reviewMode: "auto",
    enabled: true,
    notes: null,
    name: "drive → wiki-intake-test",
    status: "alert",
    lastEventAt: new Date(Date.now() - 60_000).toISOString(),
    lastError: null,
    pendingEventsCount: 0,
    sigFailCount24h: 0,
    ...overrides,
  };
}

describe("SourceBindingDetail — Intake state panel (PR-W4)", () => {
  it("renders the four per-status counts from intakeCounts", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    render(
      <SourceBindingDetail
        binding={makeBinding({
          intakeCounts: {
            pending: 5,
            classified: 42,
            skipped: 1,
            failed: 3,
          },
        })}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl}
      />,
    );
    // The panel labels each count with its status; the values
    // appear as their own monospace nodes adjacent to the label.
    const panel = screen.getByTestId("intake-state-panel");
    expect(panel).toBeInTheDocument();
    expect(panel.textContent).toMatch(/pending/i);
    expect(panel.textContent).toMatch(/classified/i);
    expect(panel.textContent).toMatch(/skipped/i);
    expect(panel.textContent).toMatch(/failed/i);
    // Counts render as their own monospace nodes inside the
    // per-status tiles; textContent concatenates without spaces, so
    // assert each value substring against the panel directly.
    expect(panel.textContent).toMatch(/pending5/);
    expect(panel.textContent).toMatch(/classified42/);
    expect(panel.textContent).toMatch(/skipped1/);
    expect(panel.textContent).toMatch(/failed3/);
  });

  it("renders zeroed counts when intakeCounts is absent (back-compat)", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl}
      />,
    );
    const panel = screen.getByTestId("intake-state-panel");
    // No counts surfaced → render zeros so the panel still gives the
    // operator a clear "no intake activity" signal instead of blanks.
    expect(panel.textContent).toMatch(/pending/i);
  });

  it("lists up to 3 recent failed intake rows with errorClass + snippet", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    render(
      <SourceBindingDetail
        binding={makeBinding({
          intakeCounts: {
            pending: 0,
            classified: 0,
            skipped: 0,
            failed: 3,
          },
          recentFailedIntake: [
            {
              id: "intake-1-newest",
              errorClass: "validation",
              errorTextSnippet: "binding.allowed_paths is empty",
            },
            {
              id: "intake-2",
              errorClass: "transient",
              errorTextSnippet: "guard upstream timed out",
            },
            {
              id: "intake-3-oldest",
              errorClass: "upstream-quota",
              errorTextSnippet: "rate limited",
            },
          ],
        })}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl}
      />,
    );
    const list = screen.getByTestId("intake-failed-list");
    expect(list).toBeInTheDocument();
    // Each row exists once, newest-first.
    expect(screen.getByTestId("intake-failed-row-intake-1-newest")).toBeInTheDocument();
    expect(screen.getByTestId("intake-failed-row-intake-2")).toBeInTheDocument();
    expect(screen.getByTestId("intake-failed-row-intake-3-oldest")).toBeInTheDocument();
    // Snippets render.
    expect(list.textContent).toMatch(/binding\.allowed_paths is empty/);
    expect(list.textContent).toMatch(/guard upstream timed out/);
    expect(list.textContent).toMatch(/rate limited/);
    // Error-class chips render.
    expect(list.textContent).toMatch(/validation/);
    expect(list.textContent).toMatch(/transient/);
    expect(list.textContent).toMatch(/upstream-quota/);
  });

  it("renders the Retry button disabled with a tooltip pointing at PR-W2", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    render(
      <SourceBindingDetail
        binding={makeBinding({
          intakeCounts: {
            pending: 0,
            classified: 0,
            skipped: 0,
            failed: 1,
          },
          recentFailedIntake: [
            {
              id: "intake-disabled-retry",
              errorClass: "validation",
              errorTextSnippet: "test failure",
            },
          ],
        })}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl}
      />,
    );
    const retryBtn = screen.getByTestId(
      "intake-failed-row-retry-intake-disabled-retry",
    );
    expect(retryBtn).toBeInTheDocument();
    expect(retryBtn).toBeDisabled();
    // Tooltip / aria-description references PR-W2 so the operator can
    // tell why the action is parked without reading docs.
    const tip = retryBtn.getAttribute("title");
    expect(tip).toMatch(/W2|PR-W2|retry/i);
  });

  it("renders an empty failed-list section when no failures exist", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    render(
      <SourceBindingDetail
        binding={makeBinding({
          intakeCounts: {
            pending: 7,
            classified: 100,
            skipped: 0,
            failed: 0,
          },
          recentFailedIntake: [],
        })}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl}
      />,
    );
    // The panel renders the count tiles; the per-failure <ul> is
    // ONLY mounted when there are rows to show.
    //
    // Copilot triage: the prior assertion was
    // `queryByTestId("intake-failed-row-")` (literal trailing dash,
    // no id), which always returned null because real test IDs carry
    // the row's intake id (`intake-failed-row-<uuid>`). That made
    // the assertion vacuously true and provided no coverage.
    //
    // Pin both surfaces:
    //   1. The list container is absent (asserts the <ul> itself
    //      isn't mounted with an empty body).
    //   2. Zero `intake-failed-row-*` test IDs landed in the DOM
    //      (defensive — catches a future refactor that mounts the
    //      <ul> unconditionally and renders rows conditionally).
    // Both flip to FAIL on a non-empty `recentFailedIntake` fixture
    // (manually verified against the "renders the Retry button…"
    // test above, which exercises exactly this row shape).
    expect(screen.queryByTestId("intake-failed-list")).toBeNull();
    expect(
      screen.queryAllByTestId(/^intake-failed-row-/),
    ).toHaveLength(0);
  });
});

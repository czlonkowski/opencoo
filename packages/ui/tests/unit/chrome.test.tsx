/**
 * Chrome tests — sidebar groups + breadcrumbs (PR-W10, phase-a
 * appendix #15 wave-15).
 *
 * Pins:
 *   - Sidebar renders four named groups in the canonical order
 *     (Operate · Knowledge · Governance · Diagnostics).
 *   - Each group contains its assigned tabs.
 *   - Group order is fixed (Operate first — daily-task primacy).
 *   - Clicking a tab still calls `setTab` with the original Tab
 *     key (the existing setTab plumbing is unchanged; only the
 *     visual grouping changes).
 *   - Tab keys are preserved 1:1 so URL-fragment routing (the
 *     `#agents`-style hash anchors) continues to address the same
 *     entries the flat-list shape did.
 *   - TopBar renders `<group> / <tab>` for landing pages and
 *     `<group> / <tab> / <row-name>` when `crumb` is provided.
 *   - Group label uses mono uppercase micro-label styling.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, within } from "@testing-library/react";

import { GROUPS, Sidebar, TopBar, groupForTab } from "../../src/components/Chrome.js";
import type { Tab } from "../../src/types.js";

describe("Sidebar groups (PR-W10)", () => {
  it("renders the four groups in canonical order (Operate first)", () => {
    render(<Sidebar tab="domains" setTab={vi.fn()} />);
    const groupEls = document.querySelectorAll("[data-group]");
    const keys = Array.from(groupEls).map((el) =>
      el.getAttribute("data-group"),
    );
    expect(keys).toEqual([
      "operate",
      "knowledge",
      "governance",
      "diagnostics",
    ]);
  });

  it("places each tab under its assigned group", () => {
    render(<Sidebar tab="domains" setTab={vi.fn()} />);
    // Read tabs out of each group section by data-group attribute.
    for (const group of GROUPS) {
      const section = document.querySelector(
        `[data-group="${group.key}"]`,
      ) as HTMLElement | null;
      expect(section).not.toBeNull();
      const buttons = within(section!).getAllByRole("button");
      // Each group's button labels come from i18n keys; assert
      // we got exactly the right *count* per group (the visual
      // arrangement, which the spec pins). Labels are checked
      // separately below.
      expect(buttons.length).toBe(group.tabs.length);
    }
  });

  it("dispatches setTab with the original Tab key on click (plumbing preserved)", () => {
    const setTab = vi.fn();
    render(<Sidebar tab="domains" setTab={setTab} />);
    // The "agents" tab is in the Operate group — pick it from
    // the Operate section so we don't depend on label order
    // across groups.
    const operate = document.querySelector(
      '[data-group="operate"]',
    ) as HTMLElement;
    const buttons = within(operate).getAllByRole("button");
    // Spec says Operate = Agents · Outputs · Activity, so the
    // first button is "agents".
    fireEvent.click(buttons[0]!);
    expect(setTab).toHaveBeenCalledWith("agents");
  });

  it("highlights the active tab via background + border, not a new color literal", () => {
    render(<Sidebar tab="prompts" setTab={vi.fn()} />);
    const knowledge = document.querySelector(
      '[data-group="knowledge"]',
    ) as HTMLElement;
    const buttons = within(knowledge).getAllByRole("button");
    // Knowledge = Domains · Sources · Prompts → "prompts" is the
    // 3rd button.
    const promptsButton = buttons[2]!;
    expect(promptsButton.style.background).toBe("var(--paper)");
    expect(promptsButton.style.borderColor).toBe("var(--rule)");
  });

  it("groupForTab returns the correct group for every Tab key", () => {
    expect(groupForTab("domains").key).toBe("knowledge");
    expect(groupForTab("sources").key).toBe("knowledge");
    expect(groupForTab("prompts").key).toBe("knowledge");
    expect(groupForTab("agents").key).toBe("operate");
    expect(groupForTab("outputs").key).toBe("operate");
    expect(groupForTab("activity").key).toBe("operate");
    expect(groupForTab("review").key).toBe("governance");
    expect(groupForTab("llmPolicy").key).toBe("governance");
    expect(groupForTab("cost").key).toBe("governance");
    expect(groupForTab("audit").key).toBe("governance");
    expect(groupForTab("reports").key).toBe("diagnostics");
  });

  // Copilot triage on PR-W10: silent fallback to Diagnostics
  // would mis-render the breadcrumb on a future tab that wasn't
  // assigned to GROUPS. Throw fast so the regression surfaces at
  // mount time in dev/test.
  it("groupForTab throws when a future tab lacks group coverage", () => {
    expect(() => groupForTab("unknown" as unknown as Tab)).toThrow(
      /no group assignment for tab/i,
    );
  });
});

describe("TopBar breadcrumbs (PR-W10)", () => {
  it("renders `<group> / <tab>` when no crumb is supplied", () => {
    render(
      <TopBar
        tab="domains"
        username="ops"
        onLogout={vi.fn()}
      />,
    );
    // The Knowledge group label lives in `nav.groups.knowledge`
    // (defaults to "knowledge" in en.json).
    const groupSeg = document.querySelector(
      '[data-crumb="group"]',
    ) as HTMLElement;
    const tabSeg = document.querySelector(
      '[data-crumb="tab"]',
    ) as HTMLElement;
    const rowSeg = document.querySelector('[data-crumb="row"]');
    expect(groupSeg.textContent).toBe("knowledge");
    expect(tabSeg.textContent).toBe("domains");
    expect(rowSeg).toBeNull();
  });

  it("renders the three-segment form when crumb is supplied", () => {
    render(
      <TopBar
        tab="domains"
        crumb="wiki-executive"
        username="ops"
        onLogout={vi.fn()}
      />,
    );
    const rowSeg = document.querySelector(
      '[data-crumb="row"]',
    ) as HTMLElement;
    expect(rowSeg).not.toBeNull();
    expect(rowSeg.textContent).toBe("wiki-executive");
    // Row segment preserves operator-chosen casing (slugs, IDs,
    // locale-suffixed names) — only group/tab get the uppercase
    // chrome treatment.
    expect(rowSeg.style.textTransform).toBe("none");
  });

  it("preserves an empty crumb as the two-segment form", () => {
    render(
      <TopBar
        tab="agents"
        crumb=""
        username="ops"
        onLogout={vi.fn()}
      />,
    );
    expect(document.querySelector('[data-crumb="row"]')).toBeNull();
  });

  it("renders the breadcrumb in mono font (design-system invariant)", () => {
    const { container } = render(
      <TopBar tab="agents" username="ops" onLogout={vi.fn()} />,
    );
    // The bar root sets the mono font once for the whole row.
    const bar = container.firstChild as HTMLElement;
    expect(bar.style.fontFamily).toBe("var(--font-mono)");
  });
});

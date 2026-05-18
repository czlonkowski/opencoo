/**
 * Sidebar roving-tabindex tests — PR-A5 (phase-a appendix #16
 * wave-16). Implements the W3C APG menubar pattern adapted for
 * the vertical sidebar:
 *
 *   - Exactly one sidebar button is in the Tab sequence at a
 *     time: the active tab carries tabindex="0", every other
 *     entry carries tabindex="-1".
 *   - Up/Down arrows move focus WITHIN the current group
 *     (Operate · Knowledge · Governance · Diagnostics). The
 *     edges do not wrap past the group boundary — Down at the
 *     last entry of Operate stays put rather than jumping into
 *     Knowledge (that's the inter-group axis's job).
 *   - Left/Right arrows move focus BETWEEN groups (to the first
 *     entry of the previous/next group). Edges do not wrap.
 *   - Home jumps to the first entry overall; End jumps to the
 *     last entry overall.
 *   - Enter / Space activates the focused entry (existing
 *     onClick chain — `setTab` is still the dispatcher).
 *
 * The aria-current="page" from PR-A2 stays on the *active* tab
 * regardless of which entry has roving focus — focus moves
 * independently of selection.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, within } from "@testing-library/react";

import { Sidebar } from "../../src/components/Chrome.js";

/** Collect every nav button in document order, paired with the
 *  group key they're nested under. The sidebar lays groups out
 *  in the canonical Operate · Knowledge · Governance ·
 *  Diagnostics order, so the resulting flat list is also the
 *  canonical "overall" order Home/End indexes against. */
function collectNavButtons(): ReadonlyArray<{
  el: HTMLButtonElement;
  group: string;
  label: string;
}> {
  const nav = document.querySelector("nav") as HTMLElement;
  const buttons = Array.from(
    nav.querySelectorAll("button"),
  ) as HTMLButtonElement[];
  return buttons.map((b) => ({
    el: b,
    group:
      b.closest("[data-group]")?.getAttribute("data-group") ?? "",
    label: b.textContent ?? "",
  }));
}

describe("Sidebar roving-tabindex (PR-A5)", () => {
  it("exactly one button carries tabindex=0 — the active tab", () => {
    render(<Sidebar tab="prompts" setTab={vi.fn()} />);
    const buttons = collectNavButtons();
    const zero = buttons.filter((b) => b.el.getAttribute("tabindex") === "0");
    const negs = buttons.filter((b) => b.el.getAttribute("tabindex") === "-1");
    expect(zero.length).toBe(1);
    // "prompts" is the active tab — it should be the single
    // tab stop.
    expect(zero[0]!.label.toLowerCase()).toContain("prompts");
    // Every other button is in the roving set.
    expect(negs.length).toBe(buttons.length - 1);
  });

  it("Arrow Down moves focus to the next entry WITHIN the same group", () => {
    render(<Sidebar tab="agents" setTab={vi.fn()} />);
    const operate = document.querySelector(
      '[data-group="operate"]',
    ) as HTMLElement;
    const buttons = within(operate).getAllByRole(
      "button",
    ) as HTMLButtonElement[];
    // Focus the active entry (agents = first in Operate).
    buttons[0]!.focus();
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(buttons[1]);
    // And again.
    fireEvent.keyDown(buttons[1]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(buttons[2]);
  });

  it("Arrow Down at the last entry of a group does NOT cross into the next group", () => {
    render(<Sidebar tab="activity" setTab={vi.fn()} />);
    const operate = document.querySelector(
      '[data-group="operate"]',
    ) as HTMLElement;
    const operateButtons = within(operate).getAllByRole(
      "button",
    ) as HTMLButtonElement[];
    const last = operateButtons[operateButtons.length - 1]!;
    last.focus();
    fireEvent.keyDown(last, { key: "ArrowDown" });
    // Focus stays on the last entry — Left/Right is the
    // inter-group axis.
    expect(document.activeElement).toBe(last);
  });

  it("Arrow Up at the first entry of a group does NOT cross into the prior group", () => {
    render(<Sidebar tab="agents" setTab={vi.fn()} />);
    const operate = document.querySelector(
      '[data-group="operate"]',
    ) as HTMLElement;
    const operateButtons = within(operate).getAllByRole(
      "button",
    ) as HTMLButtonElement[];
    const first = operateButtons[0]!;
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
  });

  it("Arrow Right jumps to the FIRST entry of the next group", () => {
    render(<Sidebar tab="agents" setTab={vi.fn()} />);
    const operate = document.querySelector(
      '[data-group="operate"]',
    ) as HTMLElement;
    const knowledge = document.querySelector(
      '[data-group="knowledge"]',
    ) as HTMLElement;
    const operateButtons = within(operate).getAllByRole(
      "button",
    ) as HTMLButtonElement[];
    const knowledgeButtons = within(knowledge).getAllByRole(
      "button",
    ) as HTMLButtonElement[];
    // Focus the second entry of Operate (Outputs) — the right
    // arrow should still jump to the FIRST entry of Knowledge,
    // not the column-aligned one.
    operateButtons[1]!.focus();
    fireEvent.keyDown(operateButtons[1]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(knowledgeButtons[0]);
  });

  it("Arrow Right at the last group does NOT wrap to the first group", () => {
    render(<Sidebar tab="reports" setTab={vi.fn()} />);
    const diagnostics = document.querySelector(
      '[data-group="diagnostics"]',
    ) as HTMLElement;
    const diagButtons = within(diagnostics).getAllByRole(
      "button",
    ) as HTMLButtonElement[];
    diagButtons[0]!.focus();
    fireEvent.keyDown(diagButtons[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(diagButtons[0]);
  });

  it("Arrow Left jumps to the FIRST entry of the previous group", () => {
    render(<Sidebar tab="domains" setTab={vi.fn()} />);
    const operate = document.querySelector(
      '[data-group="operate"]',
    ) as HTMLElement;
    const knowledge = document.querySelector(
      '[data-group="knowledge"]',
    ) as HTMLElement;
    const operateButtons = within(operate).getAllByRole(
      "button",
    ) as HTMLButtonElement[];
    const knowledgeButtons = within(knowledge).getAllByRole(
      "button",
    ) as HTMLButtonElement[];
    knowledgeButtons[1]!.focus();
    fireEvent.keyDown(knowledgeButtons[1]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(operateButtons[0]);
  });

  it("Arrow Left at the first group does NOT wrap to the last group", () => {
    render(<Sidebar tab="agents" setTab={vi.fn()} />);
    const operate = document.querySelector(
      '[data-group="operate"]',
    ) as HTMLElement;
    const operateButtons = within(operate).getAllByRole(
      "button",
    ) as HTMLButtonElement[];
    operateButtons[0]!.focus();
    fireEvent.keyDown(operateButtons[0]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(operateButtons[0]);
  });

  it("Home jumps to the first entry overall (top of Operate)", () => {
    render(<Sidebar tab="reports" setTab={vi.fn()} />);
    const diagnostics = document.querySelector(
      '[data-group="diagnostics"]',
    ) as HTMLElement;
    const operate = document.querySelector(
      '[data-group="operate"]',
    ) as HTMLElement;
    const diagButtons = within(diagnostics).getAllByRole(
      "button",
    ) as HTMLButtonElement[];
    const operateButtons = within(operate).getAllByRole(
      "button",
    ) as HTMLButtonElement[];
    diagButtons[0]!.focus();
    fireEvent.keyDown(diagButtons[0]!, { key: "Home" });
    expect(document.activeElement).toBe(operateButtons[0]);
  });

  it("End jumps to the last entry overall (last entry of Diagnostics)", () => {
    render(<Sidebar tab="agents" setTab={vi.fn()} />);
    const diagnostics = document.querySelector(
      '[data-group="diagnostics"]',
    ) as HTMLElement;
    const operate = document.querySelector(
      '[data-group="operate"]',
    ) as HTMLElement;
    const diagButtons = within(diagnostics).getAllByRole(
      "button",
    ) as HTMLButtonElement[];
    const operateButtons = within(operate).getAllByRole(
      "button",
    ) as HTMLButtonElement[];
    operateButtons[0]!.focus();
    fireEvent.keyDown(operateButtons[0]!, { key: "End" });
    expect(document.activeElement).toBe(diagButtons[diagButtons.length - 1]);
  });

  it("Enter activates the focused entry — through the native button onClick chain", () => {
    const setTab = vi.fn();
    render(<Sidebar tab="agents" setTab={setTab} />);
    const knowledge = document.querySelector(
      '[data-group="knowledge"]',
    ) as HTMLElement;
    const knowledgeButtons = within(knowledge).getAllByRole(
      "button",
    ) as HTMLButtonElement[];
    // The W3C APG menubar pattern relies on the native button
    // onClick chain to fire on Enter/Space — the keydown handler
    // must NOT intercept them. jsdom doesn't synthesize the native
    // keyup-to-click bridge, so we drive .click() to pin the
    // activation contract (real browsers fire it on Enter).
    // Knowledge = Domains · Sources · Prompts → first is Domains.
    knowledgeButtons[0]!.focus();
    fireEvent.click(knowledgeButtons[0]!);
    expect(setTab).toHaveBeenCalledWith("domains");
  });

  it("Space activates the focused entry too (native button semantics)", () => {
    const setTab = vi.fn();
    render(<Sidebar tab="agents" setTab={setTab} />);
    const knowledge = document.querySelector(
      '[data-group="knowledge"]',
    ) as HTMLElement;
    const knowledgeButtons = within(knowledge).getAllByRole(
      "button",
    ) as HTMLButtonElement[];
    // Same reason as the Enter test above — jsdom doesn't bridge
    // Space-keyup to click. fireEvent.click pins what real
    // browsers do on Space when a button is focused.
    fireEvent.click(knowledgeButtons[1]!);
    expect(setTab).toHaveBeenCalledWith("sources");
  });

  it("Enter is NOT intercepted by the keydown handler — onKeyDown does not preventDefault for Enter", () => {
    const setTab = vi.fn();
    render(<Sidebar tab="agents" setTab={setTab} />);
    const knowledge = document.querySelector(
      '[data-group="knowledge"]',
    ) as HTMLElement;
    const knowledgeButtons = within(knowledge).getAllByRole(
      "button",
    ) as HTMLButtonElement[];
    knowledgeButtons[0]!.focus();
    // Confirm the focused button keeps its native default
    // (Enter → click) — defaultPrevented is false after the
    // synthetic keydown lands.
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    knowledgeButtons[0]!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("aria-current='page' stays on the active tab regardless of where focus is", () => {
    render(<Sidebar tab="prompts" setTab={vi.fn()} />);
    const knowledge = document.querySelector(
      '[data-group="knowledge"]',
    ) as HTMLElement;
    const knowledgeButtons = within(knowledge).getAllByRole(
      "button",
    ) as HTMLButtonElement[];
    // Move roving focus to a different entry (Sources, idx 1).
    knowledgeButtons[1]!.focus();
    // Active page is still Prompts — aria-current="page" is on
    // the third button.
    expect(
      knowledgeButtons.filter(
        (b) => b.getAttribute("aria-current") === "page",
      ).length,
    ).toBe(1);
    expect(knowledgeButtons[2]!.getAttribute("aria-current")).toBe("page");
  });
});

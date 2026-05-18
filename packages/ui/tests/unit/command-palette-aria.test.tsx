/**
 * CommandPalette ARIA tests — PR-A5 (phase-a appendix #16
 * wave-16). Layered on top of the W10 palette to bring it to
 * W3C APG combobox-with-listbox semantics (vertical):
 *
 *   - The search input is a `role="combobox"`, with
 *     `aria-expanded`, `aria-controls={listboxId}`, and
 *     `aria-activedescendant={activeOptionId}` — assistive tech
 *     reads the active row without focus ever leaving the input.
 *   - The result list is a `<ul role="listbox" id={listboxId}>`
 *     so the combobox `aria-controls` resolves.
 *   - Each result is an `<li role="option" id="palette-opt-N">`
 *     with `aria-selected` set on the active row.
 *   - Arrow Up/Down move `aria-activedescendant` in lockstep
 *     with `aria-selected`.
 *   - Enter activates the active row; Esc closes.
 *
 * The scoring + dispatch contract from PR-W10 must NOT regress.
 * The new ARIA layer is additive; the existing W10 tests pin
 * the matcher behavior + click+keyboard dispatch chain.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  CommandPalette,
  type CommandPaletteProps,
} from "../../src/components/CommandPalette.js";

type Result = NonNullable<CommandPaletteProps["initialResults"]>[number];

const SAMPLE_RESULTS: ReadonlyArray<Result> = [
  {
    id: "domain:1",
    kind: "domain",
    label: "wiki-executive",
    target: { tab: "domains", entityId: "1" },
  },
  {
    id: "domain:2",
    kind: "domain",
    label: "wiki-hr",
    target: { tab: "domains", entityId: "2" },
  },
  {
    id: "binding:1",
    kind: "binding",
    label: "drive → wiki-executive",
    target: { tab: "sources", entityId: "1" },
  },
  {
    id: "agent:1",
    kind: "agent",
    label: "heartbeat (morning)",
    target: { tab: "agents", entityId: "1" },
  },
  {
    id: "prompt:heartbeat",
    kind: "prompt",
    label: "heartbeat",
    target: { tab: "prompts", promptName: "heartbeat" },
  },
];

function renderPalette(extra: Partial<CommandPaletteProps> = {}) {
  const onClose = vi.fn();
  const onNavigate = vi.fn();
  const view = render(
    <CommandPalette
      onClose={onClose}
      onNavigate={onNavigate}
      promptNames={["heartbeat"]}
      initialResults={SAMPLE_RESULTS}
      {...extra}
    />,
  );
  return { view, onClose, onNavigate };
}

describe("CommandPalette ARIA semantics (PR-A5)", () => {
  it("search input has role=combobox + the required combobox ARIA wiring", () => {
    renderPalette();
    const input = screen.getByTestId(
      "command-palette-input",
    ) as HTMLInputElement;
    expect(input.getAttribute("role")).toBe("combobox");
    // aria-expanded reflects whether the popup is visible. The
    // popup is visible whenever the palette is mounted with at
    // least one ranked option.
    expect(input.getAttribute("aria-expanded")).toBe("true");
    // aria-controls points at the listbox id we render below.
    const listboxId = input.getAttribute("aria-controls");
    expect(listboxId).toBeTruthy();
    const listbox = document.getElementById(listboxId!);
    expect(listbox).not.toBeNull();
    expect(listbox!.getAttribute("role")).toBe("listbox");
    // aria-activedescendant points at the currently-active option
    // (idx 0 on mount).
    const activeId = input.getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    const activeOption = document.getElementById(activeId!);
    expect(activeOption).not.toBeNull();
    expect(activeOption!.getAttribute("role")).toBe("option");
  });

  it("listbox has role=listbox and the id the combobox references", () => {
    renderPalette();
    const input = screen.getByTestId(
      "command-palette-input",
    ) as HTMLInputElement;
    const listboxId = input.getAttribute("aria-controls")!;
    const lists = document.querySelectorAll(`[role="listbox"]`);
    expect(lists.length).toBe(1);
    expect(lists[0]!.id).toBe(listboxId);
  });

  it("renders each result as role=option with a stable id", () => {
    renderPalette();
    const options = document.querySelectorAll('[role="option"]');
    expect(options.length).toBe(SAMPLE_RESULTS.length);
    options.forEach((opt, idx) => {
      expect(opt.id).toBe(`palette-opt-${idx}`);
    });
  });

  it("only the active option carries aria-selected=true", () => {
    renderPalette();
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    const selected = options.filter(
      (o) => o.getAttribute("aria-selected") === "true",
    );
    expect(selected.length).toBe(1);
    expect(selected[0]!.id).toBe("palette-opt-0");
  });

  it("Arrow Down shifts aria-activedescendant + aria-selected together", () => {
    renderPalette();
    const input = screen.getByTestId(
      "command-palette-input",
    ) as HTMLInputElement;
    const sheet = document.querySelector(
      '[data-component="command-palette"]',
    )!.firstChild as HTMLElement;
    expect(input.getAttribute("aria-activedescendant")).toBe("palette-opt-0");
    fireEvent.keyDown(sheet, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe("palette-opt-1");
    const selected = Array.from(
      document.querySelectorAll('[aria-selected="true"]'),
    );
    expect(selected.length).toBe(1);
    expect(selected[0]!.id).toBe("palette-opt-1");
  });

  it("Arrow Up wraps to the last option (aria-activedescendant follows)", () => {
    renderPalette();
    const input = screen.getByTestId(
      "command-palette-input",
    ) as HTMLInputElement;
    const sheet = document.querySelector(
      '[data-component="command-palette"]',
    )!.firstChild as HTMLElement;
    fireEvent.keyDown(sheet, { key: "ArrowUp" });
    const lastIdx = SAMPLE_RESULTS.length - 1;
    expect(input.getAttribute("aria-activedescendant")).toBe(
      `palette-opt-${lastIdx}`,
    );
  });

  it("Enter activates the active option (existing dispatch contract preserved)", () => {
    const { onClose, onNavigate } = renderPalette();
    const sheet = document.querySelector(
      '[data-component="command-palette"]',
    )!.firstChild as HTMLElement;
    fireEvent.keyDown(sheet, { key: "ArrowDown" });
    fireEvent.keyDown(sheet, { key: "Enter" });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith({
      tab: "domains",
      entityId: "2",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc closes the palette (existing contract preserved)", () => {
    const { onClose } = renderPalette();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("aria-activedescendant follows narrowed list when typing reranks results", () => {
    renderPalette();
    const input = screen.getByTestId(
      "command-palette-input",
    ) as HTMLInputElement;
    // Type a query that yields exactly 1 result.
    fireEvent.change(input, { target: { value: "drive" } });
    // The active option ID resolves against the *visible* ranked
    // list — the only row is now binding:1 (palette-opt-0).
    expect(input.getAttribute("aria-activedescendant")).toBe("palette-opt-0");
    const visible = document.querySelectorAll('[role="option"]');
    expect(visible.length).toBe(1);
    expect(visible[0]!.id).toBe("palette-opt-0");
    expect(visible[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("collapsed state: listbox unrendered, aria-controls + aria-activedescendant omitted, empty state announces via role=status", () => {
    // Copilot triage on PR-A5: when aria-expanded="false", the
    // combobox must not reference a listbox that isn't there. The
    // listbox is dropped from the DOM and the empty/loading text
    // surfaces as a role="status" sibling instead.
    renderPalette();
    const input = screen.getByTestId(
      "command-palette-input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "qzx-no-match" } });
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-controls")).toBeNull();
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    expect(document.querySelectorAll('[role="listbox"]').length).toBe(0);
    const status = document.querySelector(
      '[data-testid="command-palette-empty-status"]',
    );
    expect(status).not.toBeNull();
    expect(status!.getAttribute("role")).toBe("status");
  });

  it("scoring + dispatch contract from PR-W10 is unchanged", () => {
    const { onNavigate, onClose } = renderPalette();
    const input = screen.getByTestId(
      "command-palette-input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "wiki" } });
    // PR-W10 pin: wiki-executive (prefix), wiki-hr (prefix),
    // drive → wiki-executive (substring) in that order.
    const ids = Array.from(document.querySelectorAll("[data-result-id]")).map(
      (el) => el.getAttribute("data-result-id"),
    );
    expect(ids).toEqual(["domain:1", "domain:2", "binding:1"]);
    // Clicking the second-ranked result still dispatches the
    // correct target.
    fireEvent.click(
      document.querySelector(
        '[data-result-id="domain:2"]',
      ) as HTMLElement,
    );
    expect(onNavigate).toHaveBeenCalledWith({
      tab: "domains",
      entityId: "2",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

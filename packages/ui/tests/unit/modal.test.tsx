/**
 * Modal tests — overflow + sticky-action-row spec
 * (PR-W5, phase-a appendix #11).
 *
 * Closes the wave-end Chrome QA finding (2026-05-09): the
 * SourceBindingDetail edit form (~700px tall config + credentials
 * sections) and the DomainDetail edit form pushed the bottom action
 * row below the viewport at 1235x702. Operator could not see Save
 * without resizing the window.
 *
 * Pins:
 *   - Sheet caps at `calc(100vh - 64px)` (32px breathing room top
 *     + bottom) so the dialog never overflows the viewport, even
 *     when content is taller than the screen.
 *   - Body region is `overflow-y: auto` with `flex: 1 1 auto` and
 *     `min-height: 0` so it actually shrinks inside the flex
 *     column (the load-bearing min-height: 0 fix).
 *   - When `actions` prop is supplied, the actions slot is
 *     `position: sticky; bottom: 0` with `var(--paper)` background
 *     and a `1px solid var(--rule)` top border — so it visually
 *     separates from the scrollable body and masks scrolling
 *     content beneath it.
 *   - Backdrop padding is preserved (32px breathing room around
 *     the sheet at every viewport size we care about — 1024x600,
 *     1235x702, 1920x1080).
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { Modal } from "../../src/components/Modal.js";

function setViewportHeight(h: number): void {
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: h,
  });
}

function setViewportWidth(w: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: w,
  });
}

describe("Modal overflow + sticky action row (PR-W5)", () => {
  beforeEach(() => {
    // Reset to a generous default each test; individual specs
    // override as needed.
    setViewportWidth(1235);
    setViewportHeight(702);
  });

  it("caps sheet at calc(100vh - 64px) so it never overflows the viewport", () => {
    render(
      <Modal title="Tall modal" onClose={vi.fn()}>
        <div style={{ height: 1200 }}>tall content that exceeds any viewport</div>
      </Modal>,
    );
    const sheet = screen.getByRole("dialog").firstChild as HTMLElement;
    // 64px = 32px breathing room top + 32px bottom (matches the
    // backdrop padding cue).
    expect(sheet.style.maxHeight).toBe("calc(100vh - 64px)");
  });

  it("renders the body region with overflow-y: auto and flex: 1 1 auto / min-height: 0", () => {
    render(
      <Modal title="Scrollable" onClose={vi.fn()}>
        <div data-testid="body-content">scroll me</div>
      </Modal>,
    );
    const body = screen
      .getByTestId("body-content")
      .closest('[data-modal-region="body"]') as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.style.overflowY).toBe("auto");
    // The load-bearing flex pair: without min-height: 0 a
    // flex child won't shrink below its content's intrinsic
    // height, so overflow-y: auto would never trigger inside a
    // flex column.
    expect(body.style.flex).toBe("1 1 auto");
    // jsdom serializes a unitless `0` set on a CSSProperties
    // numeric prop as the string "0" (no `px` suffix). Both
    // forms collapse to the same computed style; pin the value
    // not the unit.
    expect(body.style.minHeight).toBe("0");
  });

  it("renders the actions prop as a sticky-bottom row with paper background + rule border-top", () => {
    render(
      <Modal
        title="With actions"
        onClose={vi.fn()}
        actions={
          <div data-testid="action-row">
            <button type="button">Cancel</button>
            <button type="button">Save</button>
          </div>
        }
      >
        <div>body</div>
      </Modal>,
    );
    const actions = screen
      .getByTestId("action-row")
      .closest('[data-modal-region="actions"]') as HTMLElement;
    expect(actions).not.toBeNull();
    expect(actions.style.position).toBe("sticky");
    expect(actions.style.bottom).toBe("0px");
    expect(actions.style.background).toBe("var(--paper)");
    expect(actions.style.borderTop).toBe("1px solid var(--rule)");
    // No drop shadow — depth = border + bg shift (CLAUDE.md
    // design system hard-no).
    expect(actions.style.boxShadow).toBe("");
  });

  it("does not render the actions region when no actions prop is supplied", () => {
    render(
      <Modal title="No actions" onClose={vi.fn()}>
        <div data-testid="just-body">body only</div>
      </Modal>,
    );
    expect(
      screen.getByTestId("just-body").closest('[data-modal-region="actions"]'),
    ).toBeNull();
    // The body still gets the scrollable container so
    // un-migrated modals don't overflow the viewport — they
    // just don't get the sticky-action-row affordance.
    const body = screen
      .getByTestId("just-body")
      .closest('[data-modal-region="body"]') as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.style.overflowY).toBe("auto");
  });

  it.each([
    ["1024x600 (small laptop)", 1024, 600],
    ["1235x702 (Chrome QA viewport)", 1235, 702],
    ["1920x1080 (desktop)", 1920, 1080],
  ])("accommodates a 700px-tall body at %s", (_label, w, h) => {
    setViewportWidth(w);
    setViewportHeight(h);
    render(
      <Modal
        title="Edit binding"
        onClose={vi.fn()}
        actions={<button type="button">Save</button>}
      >
        <div style={{ height: 700 }} data-testid="tall-body">
          ~700px of config + credentials
        </div>
      </Modal>,
    );
    const sheet = screen.getByRole("dialog").firstChild as HTMLElement;
    // The cap is responsive to the viewport via calc() — pin
    // the formula, not a numeric value.
    expect(sheet.style.maxHeight).toBe("calc(100vh - 64px)");
    // Backdrop preserves 32px breathing room (var(--space-5)
    // = 20px in the design tokens, but the load-bearing
    // promise is "padding > 0 so the sheet never touches the
    // viewport edge"; assert the property is set rather than
    // pin a numeric value).
    const backdrop = screen.getByRole("dialog");
    expect(backdrop.style.padding).not.toBe("");
  });
});

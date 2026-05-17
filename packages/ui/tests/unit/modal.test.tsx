/**
 * Modal tests — native <dialog> primitive (PR-A1, wave-16) +
 * overflow / sticky-action-row pins from PR-W5.
 *
 * PR-A1 promises (browser-floor primitives we now depend on):
 *   - element is <dialog>; opens via showModal() (free top-layer
 *     + focus-trap + Esc + inert behind), closes via close().
 *   - Esc dispatches close() through the browser's own handler
 *     (we only listen to the resulting `cancel` event for
 *     onClose plumbing — see the implementation).
 *   - Backdrop click closes (target-equality guard, NOT inner-click).
 *   - Inner-click does NOT close.
 *   - Focus returns to the element that had focus before the
 *     modal opened.
 *   - Firefox font-inherit quirk: explicit `font-family: inherit`
 *     CSS rule on <dialog> shipped via app.css.
 *
 * PR-W5 promises preserved (still applies inside the <dialog>):
 *   - Sheet caps at `calc(100vh - 64px)` so it never overflows
 *     the viewport.
 *   - Body region is `overflow-y: auto` + `flex: 1 1 auto` +
 *     `min-height: 0` so it shrinks inside the flex column.
 *   - When `actions` is supplied, the actions slot is
 *     `position: sticky; bottom: 0` with `var(--paper)`
 *     background + `1px solid var(--rule)` border-top.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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

describe("Modal — native <dialog> primitive (PR-A1, wave-16)", () => {
  beforeEach(() => {
    setViewportWidth(1235);
    setViewportHeight(702);
  });

  it("renders the sheet as a <dialog> element with role=dialog + aria-modal", () => {
    render(
      <Modal title="Native dialog" onClose={vi.fn()}>
        <div>body</div>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("opens via showModal() on mount", () => {
    const spy = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    try {
      render(
        <Modal title="Opens via showModal" onClose={vi.fn()}>
          <div>body</div>
        </Modal>,
      );
      expect(spy).toHaveBeenCalledTimes(1);
      const dialog = screen.getByRole("dialog");
      expect(dialog.hasAttribute("open")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("calls close() on the underlying <dialog> when unmounted", () => {
    const spy = vi.spyOn(HTMLDialogElement.prototype, "close");
    try {
      const { unmount } = render(
        <Modal title="Closes on unmount" onClose={vi.fn()}>
          <div>body</div>
        </Modal>,
      );
      unmount();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("fires onClose when the dialog's `cancel` event fires (Esc path)", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Esc closes" onClose={onClose}>
        <div>body</div>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    fireEvent(dialog, new Event("cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("fires onClose when the operator clicks the <dialog> backdrop (target-equality guard)", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal title="Backdrop closes" onClose={onClose}>
        <div data-testid="inner">body</div>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    // Click the dialog itself (acts as backdrop region).
    await user.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire onClose when the click target is an inner element", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal title="Inner click ignored" onClose={onClose}>
        <button type="button" data-testid="inner-btn">
          inner
        </button>
      </Modal>,
    );
    await user.click(screen.getByTestId("inner-btn"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("returns focus to the previously-focused element when closed", () => {
    function Harness({ open }: { open: boolean }): JSX.Element {
      return (
        <div>
          <button type="button" data-testid="trigger">
            open
          </button>
          {open ? (
            <Modal title="Returns focus" onClose={vi.fn()}>
              <button type="button" data-testid="modal-btn">
                in-modal
              </button>
            </Modal>
          ) : null}
        </div>
      );
    }

    const { rerender } = render(<Harness open={false} />);
    const trigger = screen.getByTestId("trigger") as HTMLButtonElement;
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    rerender(<Harness open={true} />);
    // While the modal is open, focus may shift into it.
    rerender(<Harness open={false} />);
    expect(document.activeElement).toBe(trigger);
  });

  it("respects prefers-reduced-motion (no enter animation class when reduce)", () => {
    const original = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (q: string) => ({
        matches: q.includes("reduce"),
        media: q,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
    try {
      render(
        <Modal title="Reduced motion" onClose={vi.fn()}>
          <div>body</div>
        </Modal>,
      );
      const dialog = screen.getByRole("dialog");
      expect(dialog.classList.contains("opencoo-dialog-enter")).toBe(false);
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });
});

describe("Modal overflow + sticky action row (PR-W5)", () => {
  beforeEach(() => {
    setViewportWidth(1235);
    setViewportHeight(702);
  });

  it("caps the <dialog> sheet at calc(100vh - 64px) so it never overflows the viewport", () => {
    render(
      <Modal title="Tall modal" onClose={vi.fn()}>
        <div style={{ height: 1200 }}>tall content that exceeds any viewport</div>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog") as HTMLElement;
    // The <dialog> itself is the sheet now (PR-A1 collapses the
    // wrapper). 64px = 32px breathing room top + 32px bottom.
    expect(dialog.style.maxHeight).toBe("calc(100vh - 64px)");
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
    expect(body.style.flex).toBe("1 1 auto");
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
    const dialog = screen.getByRole("dialog") as HTMLElement;
    expect(dialog.style.maxHeight).toBe("calc(100vh - 64px)");
  });
});

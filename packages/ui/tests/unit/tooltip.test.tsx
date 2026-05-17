/**
 * Tooltip tests — PR-C1, wave-16 (phase-a appendix #16).
 *
 * The Tooltip primitive exposes per-term operator help on jargon-
 * heavy surfaces. Its trigger is a typographic `?` character (NOT a
 * fourth glyph — the OpenArc/FilledDisc/RingWithDot trio is reserved
 * for product-concept iconography; UI affordances use type).
 *
 * Pins:
 *   - The `?` button is a native <button type="button"> and rendered
 *     in JetBrains Mono (per design-system rule for paths/IDs/
 *     micro-labels). Tab-reachable.
 *   - Focusing the `?` opens the tooltip; blur closes it.
 *   - Hover-after-200ms opens; mouse-out closes immediately.
 *   - Esc closes if open.
 *   - The `?` button has an `aria-label` referencing the term's
 *     localised label, so screen readers announce "About <term>".
 *   - The tooltip bubble has `role="tooltip"` and a stable id; the
 *     `?` button gets `aria-describedby` pointing at that id when
 *     open (and only when open).
 *   - The rendered DOM contains no emoji (design-system hard-no).
 *   - The block <Tooltip term="..."> form wraps a label and renders
 *     the `?` button next to it.
 *   - The inline <TooltipTrigger term="..."> renders only the `?`
 *     button (for cases where the label is already in the DOM).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Tooltip, TooltipTrigger } from "../../src/components/Tooltip.js";

// `?` is the only printable U+003F; rejecting any character outside
// the BMP ascii/Latin-1 keyboard range catches emoji unambiguously.
// We use a conservative range covering everything we expect in
// English + Polish: ASCII (0x20–0x7E), Latin-1 supplement letters
// (0xA0–0xFF), Latin Extended-A (0x100–0x17F), and the typographic
// space/dash/quote block (0x2010–0x203A). Everything else is
// treated as "not a normal character" — emoji, dingbats, geometric
// shapes (which would include any fourth-glyph attempt).
function containsNonTextSymbol(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const ascii = cp >= 0x20 && cp <= 0x7e;
    const latin = cp >= 0xa0 && cp <= 0x17f;
    const punct = cp >= 0x2010 && cp <= 0x203a;
    const ws = cp === 0x09 || cp === 0x0a || cp === 0x0d;
    if (!(ascii || latin || punct || ws)) return true;
  }
  return false;
}

describe("Tooltip primitive (PR-C1, wave-16)", () => {
  it("renders the `?` button with an aria-label referencing the term", () => {
    render(<TooltipTrigger term="reviewMode" />);
    const btn = screen.getByRole("button");
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("type")).toBe("button");
    // The button label routes through i18n: "About <term-label>".
    expect(btn.getAttribute("aria-label")).toMatch(/review mode/i);
    // The character is the literal `?`, not an icon glyph.
    expect(btn.textContent).toBe("?");
  });

  it("renders the trigger in JetBrains Mono so it reads as type, not iconography", () => {
    render(<TooltipTrigger term="reviewMode" />);
    const btn = screen.getByRole("button") as HTMLElement;
    expect(btn.style.fontFamily).toBe("var(--font-mono)");
  });

  it("places the `?` button in the natural tab order", () => {
    render(<TooltipTrigger term="reviewMode" />);
    const btn = screen.getByRole("button");
    // No tabindex override — natural focus order keeps the trigger
    // keyboard-reachable for screen-reader operators.
    const ti = btn.getAttribute("tabindex");
    expect(ti === null || ti === "0").toBe(true);
  });

  it("does not render the bubble while closed (no `role=tooltip` in DOM)", () => {
    render(<TooltipTrigger term="reviewMode" />);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("opens the tooltip on focus; bubble has role=tooltip and an id; describedby chains them", async () => {
    const user = userEvent.setup();
    render(<TooltipTrigger term="reviewMode" />);
    const btn = screen.getByRole("button");
    await user.tab(); // Focuses the `?` button (first tab-reachable).
    expect(btn).toHaveFocus();
    const bubble = await screen.findByRole("tooltip");
    expect(bubble.id).toBeTruthy();
    expect(btn.getAttribute("aria-describedby")).toBe(bubble.id);
  });

  it("clears aria-describedby when the bubble is closed", async () => {
    const user = userEvent.setup();
    render(<TooltipTrigger term="reviewMode" />);
    const btn = screen.getByRole("button");
    await user.tab();
    await screen.findByRole("tooltip");
    expect(btn.getAttribute("aria-describedby")).toBeTruthy();
    // Tab away to blur the button — closes the tooltip.
    await user.tab();
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(btn.getAttribute("aria-describedby")).toBeNull();
  });

  it("closes the bubble on Esc when open", async () => {
    const user = userEvent.setup();
    render(<TooltipTrigger term="reviewMode" />);
    await user.tab();
    await screen.findByRole("tooltip");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("opens on hover after 200ms; closes immediately on mouse-out", async () => {
    vi.useFakeTimers();
    try {
      render(<TooltipTrigger term="reviewMode" />);
      const btn = screen.getByRole("button");
      // Dispatch synchronously — user-event's hover() awaits real
      // timers even with fake timers wired, so we use fireEvent
      // directly. floating-ui's useHover listens on pointerenter +
      // mouseenter (jsdom dispatches both with the userEvent
      // shape).
      const { fireEvent } = await import("@testing-library/react");
      act(() => {
        fireEvent.pointerEnter(btn);
        fireEvent.mouseEnter(btn);
      });
      // Not yet — hover-open is debounced 200ms to avoid flashes.
      expect(screen.queryByRole("tooltip")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(220);
      });
      expect(screen.queryByRole("tooltip")).not.toBeNull();
      act(() => {
        fireEvent.pointerLeave(btn);
        fireEvent.mouseLeave(btn);
        vi.advanceTimersByTime(50);
      });
      expect(screen.queryByRole("tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders no emoji or geometric-shape characters in the tooltip DOM", async () => {
    const user = userEvent.setup();
    render(<TooltipTrigger term="reviewMode" />);
    const btn = screen.getByRole("button");
    expect(containsNonTextSymbol(btn.textContent ?? "")).toBe(false);
    await user.tab();
    const bubble = await screen.findByRole("tooltip");
    expect(containsNonTextSymbol(bubble.textContent ?? "")).toBe(false);
  });

  it("uses design tokens for color + background (no inline hex literals)", () => {
    render(<TooltipTrigger term="reviewMode" />);
    const btn = screen.getByRole("button") as HTMLElement;
    // W11 audit-fence: no inline color literals. Every chrome
    // property routes through a design-system var.
    expect(btn.style.color).toMatch(/var\(--/);
    expect(btn.style.background).toMatch(/var\(--/);
    expect(btn.style.borderColor).toMatch(/var\(--/);
  });

  it("block <Tooltip term=...> form renders the label text AND the `?` button", () => {
    render(
      <Tooltip term="reviewMode">
        <span>Review mode</span>
      </Tooltip>,
    );
    // Label content survives.
    expect(screen.getByText("Review mode")).not.toBeNull();
    // Trigger sits in the same wrapper.
    const btn = screen.getByRole("button");
    expect(btn.textContent).toBe("?");
  });

  it("renders distinct ids per instance so multiple triggers don't collide", () => {
    // Both triggers mounted at once — useId fires per component
    // instance at mount time. We assert each trigger holds a
    // distinct describedby target (i.e. its bubble's id is unique)
    // by opening both via direct DOM `focus()` and reading the
    // describedby attribute before either closes.
    render(
      <>
        <TooltipTrigger term="reviewMode" />
        <TooltipTrigger term="allowedPaths" />
      </>,
    );
    const [first, second] = screen.getAllByRole("button");
    act(() => {
      first?.focus();
    });
    const id1 = first?.getAttribute("aria-describedby");
    act(() => {
      first?.blur();
      second?.focus();
    });
    const id2 = second?.getAttribute("aria-describedby");
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id2).not.toBe(id1);
  });
});

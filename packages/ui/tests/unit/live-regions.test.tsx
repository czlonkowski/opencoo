/**
 * App-level live regions — PR-A4 (wave-16, phase-a appendix #16).
 *
 * Pins:
 *   - `<LiveRegions />` renders TWO `<div aria-live>` regions
 *     with the two pinned ids (`opencoo-aria-live-polite` and
 *     `opencoo-aria-live-assertive`).
 *   - Each region carries `aria-atomic="true"` so a screen reader
 *     re-narrates the FULL contents on every change.
 *   - Polite region carries `aria-live="polite"`; assertive carries
 *     `aria-live="assertive"`.
 *   - Each region uses the visually-hidden `SR_ONLY_STYLE` recipe
 *     (the regions must never paint visually).
 *   - `pushAnnouncement(...)` updates the matching region's text.
 *   - `tone: 'assertive'` only touches the assertive region; default
 *     polite only touches the polite region.
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, within } from "@testing-library/react";

import {
  ASSERTIVE_REGION_ID,
  LiveRegions,
  POLITE_REGION_ID,
} from "../../src/components/LiveRegions.js";
import {
  __resetAnnouncementsForTests,
  pushAnnouncement,
} from "../../src/lib/announce.js";

describe("LiveRegions — ids + ARIA attrs", () => {
  beforeEach(() => {
    __resetAnnouncementsForTests();
  });
  afterEach(() => {
    __resetAnnouncementsForTests();
  });

  it("renders the polite region with the pinned id + aria attrs", () => {
    render(<LiveRegions />);
    const polite = document.getElementById(POLITE_REGION_ID);
    expect(polite).not.toBeNull();
    expect(polite!.getAttribute("aria-live")).toBe("polite");
    expect(polite!.getAttribute("aria-atomic")).toBe("true");
    // aria-label is the i18n key (en.json default in setup.ts).
    expect(polite!.getAttribute("aria-label")).toBe("Status updates");
  });

  it("renders the assertive region with the pinned id + aria attrs", () => {
    render(<LiveRegions />);
    const assertive = document.getElementById(ASSERTIVE_REGION_ID);
    expect(assertive).not.toBeNull();
    expect(assertive!.getAttribute("aria-live")).toBe("assertive");
    expect(assertive!.getAttribute("aria-atomic")).toBe("true");
    expect(assertive!.getAttribute("aria-label")).toBe("Errors and alerts");
  });

  it("each region uses the SR_ONLY_STYLE recipe (visually hidden, off-flow)", () => {
    render(<LiveRegions />);
    const polite = document.getElementById(POLITE_REGION_ID) as HTMLElement;
    // The recipe is `position: absolute`, `width/height: 1`,
    // `overflow: hidden`, clip-rect, whitespace nowrap. We pin
    // the load-bearing ones — anything that lets the region paint
    // would be a regression.
    expect(polite.style.position).toBe("absolute");
    expect(polite.style.overflow).toBe("hidden");
    expect(polite.style.whiteSpace).toBe("nowrap");
  });

  it("renders exactly two live regions (no duplicates from re-render)", () => {
    const { rerender } = render(<LiveRegions />);
    rerender(<LiveRegions />);
    const liveRegions = document.querySelectorAll("[aria-live]");
    // Only OUR two regions exist when nothing else mounts.
    expect(liveRegions.length).toBe(2);
  });
});

describe("LiveRegions — pushAnnouncement routing", () => {
  beforeEach(() => {
    __resetAnnouncementsForTests();
  });
  afterEach(() => {
    __resetAnnouncementsForTests();
  });

  it("default tone pushes text into the polite region only", () => {
    render(<LiveRegions />);
    act(() => {
      pushAnnouncement("saved");
    });
    const polite = document.getElementById(POLITE_REGION_ID) as HTMLElement;
    const assertive = document.getElementById(
      ASSERTIVE_REGION_ID,
    ) as HTMLElement;
    expect(within(polite).getByText("saved")).not.toBeNull();
    expect(assertive.textContent).toBe("");
  });

  it("tone: 'assertive' pushes text into the assertive region only", () => {
    render(<LiveRegions />);
    act(() => {
      pushAnnouncement("boom", { tone: "assertive" });
    });
    const polite = document.getElementById(POLITE_REGION_ID) as HTMLElement;
    const assertive = document.getElementById(
      ASSERTIVE_REGION_ID,
    ) as HTMLElement;
    expect(polite.textContent).toBe("");
    expect(within(assertive).getByText("boom")).not.toBeNull();
  });

  it("auto-removes the message after the configured timeout", () => {
    vi.useFakeTimers();
    try {
      render(<LiveRegions />);
      act(() => {
        pushAnnouncement("transient", { timeoutMs: 1000 });
      });
      const polite = document.getElementById(POLITE_REGION_ID) as HTMLElement;
      expect(polite.textContent).toContain("transient");
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(polite.textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("multiple messages render as separate child nodes (key-stable)", () => {
    render(<LiveRegions />);
    act(() => {
      pushAnnouncement("first");
      pushAnnouncement("second");
    });
    const polite = document.getElementById(POLITE_REGION_ID) as HTMLElement;
    expect(polite.textContent).toContain("first");
    expect(polite.textContent).toContain("second");
    expect(polite.childElementCount).toBe(2);
  });
});

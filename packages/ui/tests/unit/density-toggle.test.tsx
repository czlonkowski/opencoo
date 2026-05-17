/**
 * DensityToggle in the TopBar — PR-C6, phase-a appendix #16 wave-16.
 *
 * The toggle lives next to the C2 locale switcher and exposes two
 * options (comfortable / compact). Clicking switches `<body
 * data-density>` AND `localStorage.opencoo_density` so the CSS
 * variant scope in `colors_and_type.css` takes effect immediately.
 *
 * Pin matrix:
 *   1. Renders BOTH options as discrete buttons in the TopBar.
 *   2. Active option is visually distinct (aria-pressed="true").
 *   3. Clicking the inactive option flips body[data-density] +
 *      localStorage.
 *   4. Toggle does not render when `onChangeLocale` is omitted
 *      (gating shared with C2's LocaleSwitcher so existing TopBar
 *      fixtures continue to render bare).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

import { TopBar } from "../../src/components/Chrome.js";
import i18n from "../../src/lib/i18n.js";

const STORAGE_KEY = "opencoo_density";

beforeEach(() => {
  document.body.removeAttribute("data-density");
});

afterEach(async () => {
  if (i18n.language !== "en") {
    await i18n.changeLanguage("en");
  }
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore — jsdom always provides localStorage.
  }
  document.body.removeAttribute("data-density");
});

describe("Density toggle in TopBar (PR-C6)", () => {
  it("renders comfortable + compact options as discrete buttons", () => {
    const { container } = render(
      <TopBar
        tab="domains"
        username="alice"
        onLogout={vi.fn()}
        onChangeLocale={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const region = container.querySelector(
      '[data-component="density-toggle"]',
    );
    expect(region).not.toBeNull();
    const buttons = region!.querySelectorAll("button");
    expect(buttons.length).toBe(2);
    const labels = Array.from(buttons).map((b) => b.textContent?.trim());
    expect(labels).toEqual(["comfortable", "compact"]);
  });

  it("marks the active option via aria-pressed='true' (default comfortable)", () => {
    const { container } = render(
      <TopBar
        tab="domains"
        username="alice"
        onLogout={vi.fn()}
        onChangeLocale={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const buttons = container.querySelectorAll(
      '[data-component="density-toggle"] button',
    );
    const [comfortable, compact] = buttons;
    expect(comfortable!.getAttribute("aria-pressed")).toBe("true");
    expect(compact!.getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking 'compact' flips body[data-density] + localStorage + aria-pressed", () => {
    const { container } = render(
      <TopBar
        tab="domains"
        username="alice"
        onLogout={vi.fn()}
        onChangeLocale={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const buttons = container.querySelectorAll(
      '[data-component="density-toggle"] button',
    );
    const [, compact] = buttons;
    fireEvent.click(compact!);

    expect(document.body.getAttribute("data-density")).toBe("compact");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("compact");

    // After the click, the SECOND button is the active one.
    const refreshed = container.querySelectorAll(
      '[data-component="density-toggle"] button',
    );
    expect(refreshed[0]!.getAttribute("aria-pressed")).toBe("false");
    expect(refreshed[1]!.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not render when onChangeLocale is omitted (test render path)", () => {
    // The TopBar tests for PR-W10 / PR-A2 / PR-C2 render WITHOUT
    // `onChangeLocale` so the locale switcher / density toggle stay
    // out of the way. Density toggle inherits the same gating so
    // existing breadcrumb fixtures keep working without rewriting.
    const { container } = render(
      <TopBar tab="domains" username="alice" onLogout={vi.fn()} />,
    );
    const region = container.querySelector(
      '[data-component="density-toggle"]',
    );
    expect(region).toBeNull();
  });
});

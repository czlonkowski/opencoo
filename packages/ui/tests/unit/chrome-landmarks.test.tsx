/**
 * Chrome landmarks + aria — wave-16 PR-A2.
 *
 * Pins:
 *   - TopBar emits `<header role="banner">` so screen readers and
 *     keyboard nav can land on the page chrome as a landmark.
 *   - Sidebar emits `<nav aria-label="…">` (the existing `<nav>`
 *     element gains the label; the label key is `nav.primary`).
 *   - Sidebar group headers are `<h2>` (one per group), not the
 *     `<div>` micro-labels W10 left in place. The visual recipe
 *     stays.
 *   - Exactly one `<h2>` per group, four total.
 *   - Active tab carries `aria-current="page"`; inactive don't.
 *
 * The `<main aria-labelledby="opencoo-page-h1">` invariant lives
 * in App.tsx — the corresponding pin is exercised by the per-
 * route tests + `h1-coverage.test.tsx`, since the id has to land
 * on the route's h1 for `aria-labelledby` to resolve.
 */
import { describe, expect, it, vi } from "vitest";
import { render, within } from "@testing-library/react";

import { GROUPS, Sidebar, TopBar } from "../../src/components/Chrome.js";

describe("Chrome landmarks (wave-16 PR-A2)", () => {
  it("TopBar renders inside <header role='banner'>", () => {
    const { container } = render(
      <TopBar tab="domains" username="ops" onLogout={vi.fn()} />,
    );
    const header = container.querySelector("header[role='banner']");
    expect(header).not.toBeNull();
  });

  it("Sidebar <nav> carries an aria-label (nav.primary key)", () => {
    const { container } = render(
      <Sidebar tab="domains" setTab={vi.fn()} />,
    );
    const nav = container.querySelector("nav");
    expect(nav).not.toBeNull();
    // i18n init in setup.ts resolves to en.json; the default
    // English text for nav.primary is "primary navigation".
    expect(nav!.getAttribute("aria-label")).toBe("primary navigation");
  });

  it("Sidebar group headers are <h2> elements, one per group (four total)", () => {
    const { container } = render(
      <Sidebar tab="domains" setTab={vi.fn()} />,
    );
    const headings = container.querySelectorAll("h2");
    expect(headings.length).toBe(GROUPS.length);
    expect(headings.length).toBe(4);
    // Each h2 lives inside the matching `[data-group]` container,
    // not at the sidebar root — assert one h2 per group section.
    for (const group of GROUPS) {
      const section = container.querySelector(
        `[data-group="${group.key}"]`,
      );
      expect(section).not.toBeNull();
      const h2s = section!.querySelectorAll("h2");
      expect(h2s.length).toBe(1);
    }
  });

  it("Sidebar group headers preserve the W10 micro-label visual recipe", () => {
    // The visual style stays exactly the same — only the tag
    // changes from <div> to <h2>. This pin guards against a
    // future "tidy up" PR re-introducing default <h2> chrome.
    const { container } = render(
      <Sidebar tab="domains" setTab={vi.fn()} />,
    );
    const h2 = container.querySelector("h2");
    expect(h2).not.toBeNull();
    // Mono uppercase micro-label — same recipe as the W10 div.
    expect(h2!.style.fontFamily).toBe("var(--font-mono)");
    expect(h2!.style.textTransform).toBe("uppercase");
  });

  it("active tab carries aria-current='page'; inactive don't", () => {
    const { container } = render(
      <Sidebar tab="prompts" setTab={vi.fn()} />,
    );
    const knowledge = container.querySelector(
      '[data-group="knowledge"]',
    ) as HTMLElement;
    const buttons = within(knowledge).getAllByRole("button");
    // Knowledge = Domains · Sources · Prompts — prompts is index 2.
    const prompts = buttons[2]!;
    const domains = buttons[0]!;
    expect(prompts.getAttribute("aria-current")).toBe("page");
    // Inactive buttons must NOT carry the attribute (a literal
    // `aria-current="false"` is a valid value, so assert the
    // attribute is absent rather than checking equality).
    expect(domains.hasAttribute("aria-current")).toBe(false);
  });
});

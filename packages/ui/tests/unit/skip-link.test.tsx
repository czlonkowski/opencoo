/**
 * "Skip to content" skip-link — PR-A6 (wave-16, phase-a appendix #16).
 *
 * Pins:
 *   1. The skip-link is the FIRST focusable element in the document
 *      so a Tab press from the URL bar lands on it before anything
 *      else. (WAI-ARIA Authoring Practices, "skip links" pattern.)
 *   2. It targets `#opencoo-main` so activating it moves keyboard
 *      focus into the route's content region — not just scrolls past
 *      the chrome.
 *   3. The element is OFF-SCREEN by default (top < 0) so it does
 *      not interfere with sighted-mouse operators, and SLIDES INTO
 *      view on `:focus` so a keyboard operator sees it.
 *   4. The slide-in is one-shot (reduced-motion compliant) — no
 *      `animation` declaration attaches to the skip-link rules.
 *   5. The visible label is the i18n key `accessibility.skipToContent`.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

vi.mock("../../src/routes/Activity.js", () => ({
  Activity: (): JSX.Element => <div data-testid="route-activity">Activity</div>,
}));
vi.mock("../../src/routes/Agents.js", () => ({
  Agents: (): JSX.Element => <div data-testid="route-agents">Agents</div>,
}));
vi.mock("../../src/routes/Audit.js", () => ({
  Audit: (): JSX.Element => <div data-testid="route-audit">Audit</div>,
}));
vi.mock("../../src/routes/Cost.js", () => ({
  Cost: (): JSX.Element => <div data-testid="route-cost">Cost</div>,
}));
vi.mock("../../src/routes/Domains.js", () => ({
  Domains: (): JSX.Element => <div data-testid="route-domains">Domains</div>,
}));
vi.mock("../../src/routes/LlmPolicy.js", () => ({
  LlmPolicy: (): JSX.Element => (
    <div data-testid="route-llmPolicy">LlmPolicy</div>
  ),
}));
vi.mock("../../src/routes/Outputs.js", () => ({
  Outputs: (): JSX.Element => <div data-testid="route-outputs">Outputs</div>,
}));
vi.mock("../../src/routes/Prompts.js", () => ({
  Prompts: (): JSX.Element => <div data-testid="route-prompts">Prompts</div>,
}));
vi.mock("../../src/routes/Reports.js", () => ({
  Reports: (): JSX.Element => <div data-testid="route-reports">Reports</div>,
}));
vi.mock("../../src/routes/Review.js", () => ({
  Review: (): JSX.Element => <div data-testid="route-review">Review</div>,
}));
vi.mock("../../src/routes/Sources.js", () => ({
  Sources: (): JSX.Element => <div data-testid="route-sources">Sources</div>,
}));

vi.mock("../../src/lib/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/lib/api.js")>(
      "../../src/lib/api.js",
    );
  return {
    ...actual,
    fetchAdmin: vi.fn(async (url: string) => {
      if (url.includes("/_csrf")) {
        return {
          csrfToken: "test-csrf",
          username: "tester",
          _llmDebugLogActive: false,
        };
      }
      return {};
    }),
  };
});

beforeEach(() => {
  window.sessionStorage.setItem("opencoo_pat", "test-pat");
});

afterEach(() => {
  window.sessionStorage.clear();
  vi.resetModules();
});

async function loadApp(): Promise<typeof import("../../src/App.js")> {
  return await import("../../src/App.js");
}

describe("Skip-to-content link (PR-A6)", () => {
  it("renders as the FIRST focusable element in the document", async () => {
    const { App } = await loadApp();
    const { container } = render(<App />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='route-domains']")).not.toBeNull();
    });
    const focusables = container.querySelectorAll(
      "a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    expect(focusables.length).toBeGreaterThan(0);
    const first = focusables[0]!;
    expect(first.tagName).toBe("A");
    expect(first.getAttribute("href")).toBe("#opencoo-main");
    expect(first.classList.contains("opencoo-skip-link")).toBe(true);
  });

  it("href points at the #opencoo-main landmark target", async () => {
    const { App } = await loadApp();
    const { container } = render(<App />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='route-domains']")).not.toBeNull();
    });
    const link = container.querySelector("a.opencoo-skip-link") as
      | HTMLAnchorElement
      | null;
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("#opencoo-main");
    const target = container.querySelector("#opencoo-main");
    expect(target).not.toBeNull();
    const main = container.querySelector("main");
    expect(main).not.toBeNull();
    const idOnMain = main!.id === "opencoo-main";
    const idInsideMain = main!.querySelector("#opencoo-main") !== null;
    expect(idOnMain || idInsideMain).toBe(true);
  });

  it("renders the label from the accessibility.skipToContent i18n key", async () => {
    const { App } = await loadApp();
    const { container } = render(<App />);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='route-domains']")).not.toBeNull();
    });
    const link = container.querySelector("a.opencoo-skip-link");
    expect(link).not.toBeNull();
    expect(link!.textContent?.trim()).toBe("Skip to content");
  });

  it("CSS positions the link OFF-SCREEN by default and slides into view on focus", () => {
    // Source-level CSS pin — the CSS file is parsed directly because
    // jsdom does not reliably resolve external stylesheets.
    const cssPath = resolve(__dirname, "../../src/styles/app.css");
    const css = readFileSync(cssPath, "utf-8");
    expect(css).toMatch(/\.opencoo-skip-link\s*\{[^}]*position:\s*(absolute|fixed)/);
    expect(css).toMatch(/\.opencoo-skip-link\s*\{[^}]*top:\s*-/);
    // Focused rule slides into view (positive top value). The
    // selector may be comma-listed with :focus-visible — match any
    // selector that starts with `.opencoo-skip-link:focus` up to the
    // opening brace, then a positive `top` value (literal digit or
    // a `var(--space…)` token that resolves to a positive offset).
    expect(css).toMatch(
      /\.opencoo-skip-link:focus[^{]*\{[^}]*top:\s*(\d|var\(--space)/,
    );
    const skipBlocks = [
      ...css.matchAll(/\.opencoo-skip-link[^{]*\{[^}]*\}/g),
    ];
    for (const block of skipBlocks) {
      expect(/animation\s*:/.test(block[0])).toBe(false);
    }
  });
});

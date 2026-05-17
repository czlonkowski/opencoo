/**
 * Cross-route Display-placement test — PR-C4 (wave-16,
 * phase-a appendix #16).
 *
 * Asserts the wave-16 contract that the editorial-serif
 * `<Display>` lands in EXACTLY three places in v0.1:
 *
 *   - `routes/Reports.tsx` — heartbeat lede above the report list
 *   - `routes/Prompts.tsx` — empty-state lede when no prompt picked
 *   - `routes/Domains.tsx` — tab top-line summary
 *
 * Other routes (Activity, Sources, Outputs, Audit, Agents,
 * LlmPolicy) MUST NOT render an `<h2 class="t-lede">`.
 *
 * The check is structural: we render each route with a
 * minimum-viable fetch stub and look for an `h2.t-lede`
 * element. The C7 cross-route snapshot test (wave-end gate) will
 * tighten this with full route-walk asserts.
 */
import { describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

import { Reports } from "../../src/routes/Reports.js";
import { Prompts } from "../../src/routes/Prompts.js";
import { Domains } from "../../src/routes/Domains.js";
import { Activity } from "../../src/routes/Activity.js";
import { Sources } from "../../src/routes/Sources.js";
import { Outputs } from "../../src/routes/Outputs.js";
import { Audit } from "../../src/routes/Audit.js";
import { Agents } from "../../src/routes/Agents.js";
import { LlmPolicy } from "../../src/routes/LlmPolicy.js";

/** Returns an empty/healthy 200 envelope for any URL the route asks for. */
function makeEmptyFetch(): typeof fetch {
  return vi.fn(async () => {
    const body = {
      rows: [],
      entries: [],
      reports: [],
      events: [],
      runs: [],
      channels: [],
      bindings: [],
      instances: [],
      ok: true,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

/** Counts `<Display level=2>` placements (`.t-lede` — the typescale
 *  class is the load-bearing marker; tag varies because `as="p"`
 *  is legitimate in non-heading contexts e.g. the Prompts empty-
 *  pane lede and the Domains tab-summary). */
function countLedeNodes(container: HTMLElement): number {
  return container.querySelectorAll(".t-lede").length;
}

describe("Display placement contract (PR-C4, wave-16)", () => {
  it("Reports route renders at least one <Display level=2>", () => {
    const { container } = render(<Reports fetchImpl={makeEmptyFetch()} />);
    expect(countLedeNodes(container)).toBeGreaterThanOrEqual(1);
  });

  it("Prompts route renders at least one <Display level=2> (empty-state lede)", () => {
    const { container } = render(<Prompts fetchImpl={makeEmptyFetch()} />);
    expect(countLedeNodes(container)).toBeGreaterThanOrEqual(1);
  });

  it("Domains route renders at least one <Display level=2>", () => {
    const { container } = render(<Domains fetchImpl={makeEmptyFetch()} />);
    expect(countLedeNodes(container)).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ["Activity", Activity],
    ["Sources", Sources],
    ["Outputs", Outputs],
    ["Audit", Audit],
    ["Agents", Agents],
    ["LlmPolicy", LlmPolicy],
  ] as const)(
    "%s route renders NO <Display level=2> (not a strategic placement)",
    (_label, RouteComponent) => {
      const fetchImpl = makeEmptyFetch();
      // Each route takes a `fetchImpl` test-seam prop. Cast through
      // unknown — the shared shape is { fetchImpl?: typeof fetch }
      // for every admin-API consumer.
      const { container } = render(
        <RouteComponent
          {...({ fetchImpl } as unknown as Record<string, unknown>)}
        />,
      );
      expect(countLedeNodes(container)).toBe(0);
      cleanup();
    },
  );
});

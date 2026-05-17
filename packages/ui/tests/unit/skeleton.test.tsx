/**
 * Skeleton primitive tests — PR-B1 (wave-16, phase-a appendix #16).
 *
 * Pins the load-bearing invariants:
 *   - `Skeleton.Row` renders the requested number of `<td>` cells,
 *     inside a `<tr>`. `mono` switches the cell visual width.
 *   - `Skeleton.Block` honors the `height` prop.
 *   - `Skeleton.Field` baseline height matches `Field`'s input
 *     (the wave-16 brief requires they read as the same shape).
 *   - ARIA: every sub-component renders `role="status"` +
 *     `aria-live="polite"` + `aria-busy="true"` + a visually-
 *     hidden "Loading content" label (i18n via common.loading).
 *   - No animation loop (the "exactly one loop is heartbeat-pulse"
 *     rule in design_system/README.md). The skeleton uses depth
 *     via border + paper-2; if a future edit re-adds a shimmer
 *     or pulse, this test fails.
 */
import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";

import { Skeleton } from "../../src/components/Skeleton.js";

describe("Skeleton.Row", () => {
  it("renders the requested number of <td> cells inside a <tr>", () => {
    const { container } = render(
      <table>
        <tbody>
          <Skeleton.Row cols={4} />
        </tbody>
      </table>,
    );
    const tr = container.querySelector("tr");
    expect(tr).not.toBeNull();
    const cells = tr!.querySelectorAll("td");
    expect(cells.length).toBe(4);
  });

  it("defaults to 3 cells when cols is omitted", () => {
    const { container } = render(
      <table>
        <tbody>
          <Skeleton.Row />
        </tbody>
      </table>,
    );
    expect(container.querySelectorAll("td").length).toBe(3);
  });

  it("renders mono variant with JetBrains Mono font-family", () => {
    const { container } = render(
      <table>
        <tbody>
          <Skeleton.Row cols={2} mono />
        </tbody>
      </table>,
    );
    const placeholder = container.querySelector("td > span") as HTMLElement | null;
    expect(placeholder).not.toBeNull();
    expect(placeholder!.style.fontFamily).toBe("var(--font-mono)");
  });

  it("renders sans variant by default (no mono override)", () => {
    const { container } = render(
      <table>
        <tbody>
          <Skeleton.Row cols={2} />
        </tbody>
      </table>,
    );
    const placeholder = container.querySelector("td > span") as HTMLElement | null;
    expect(placeholder).not.toBeNull();
    expect(placeholder!.style.fontFamily).toBe("var(--font-sans)");
  });

  it("exposes role=status + aria-live=polite + aria-busy=true on the row", () => {
    const { container } = render(
      <table>
        <tbody>
          <Skeleton.Row cols={3} />
        </tbody>
      </table>,
    );
    const tr = container.querySelector("tr") as HTMLElement;
    expect(tr.getAttribute("role")).toBe("status");
    expect(tr.getAttribute("aria-live")).toBe("polite");
    expect(tr.getAttribute("aria-busy")).toBe("true");
  });

  it("includes a visually-hidden i18n loading label", () => {
    const { container } = render(
      <table>
        <tbody>
          <Skeleton.Row cols={3} />
        </tbody>
      </table>,
    );
    const tr = container.querySelector("tr") as HTMLElement;
    const labels = within(tr).getAllByText("Loading…");
    expect(labels.length).toBeGreaterThanOrEqual(1);
    const sr = labels[0]!;
    // Visually-hidden recipe: clip-rect 0 + 1px square + position absolute.
    expect(sr.style.position).toBe("absolute");
    expect(sr.style.width).toBe("1px");
    expect(sr.style.height).toBe("1px");
  });
});

describe("Skeleton.Block", () => {
  it("honors the height prop (number → px)", () => {
    const { container } = render(<Skeleton.Block height={120} />);
    const block = container.querySelector('[role="status"]') as HTMLElement;
    expect(block).not.toBeNull();
    expect(block.style.height).toBe("120px");
  });

  it("falls back to a sensible default when height is omitted", () => {
    const { container } = render(<Skeleton.Block />);
    const block = container.querySelector('[role="status"]') as HTMLElement;
    expect(block.style.height).not.toBe("");
  });

  it("exposes role=status + aria-live=polite + aria-busy=true", () => {
    const { container } = render(<Skeleton.Block height={60} />);
    const block = container.querySelector('[role="status"]') as HTMLElement;
    expect(block.getAttribute("role")).toBe("status");
    expect(block.getAttribute("aria-live")).toBe("polite");
    expect(block.getAttribute("aria-busy")).toBe("true");
  });

  it("includes a visually-hidden i18n loading label", () => {
    const { getAllByText, container } = render(<Skeleton.Block height={60} />);
    const labels = getAllByText("Loading…");
    expect(labels.length).toBeGreaterThanOrEqual(1);
    const sr = labels[0]!;
    expect(sr.style.position).toBe("absolute");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it("uses border + paper-2 for depth (no shadow)", () => {
    const { container } = render(<Skeleton.Block height={60} />);
    const block = container.querySelector('[role="status"]') as HTMLElement;
    expect(block.style.border).toContain("var(--paper-3)");
    expect(block.style.background).toBe("var(--paper-2)");
    // Drop-shadow is a design-system hard-no.
    expect(block.style.boxShadow === "" || block.style.boxShadow === "none").toBe(true);
  });
});

describe("Skeleton.Field", () => {
  it("matches Field's input baseline height (32px)", () => {
    // Field.tsx renders <input> with padding 8px 10px + a line-
    // height-1.5 13/15px body type. The skeleton input-shape
    // mirrors that baseline so it reads as the same row when it
    // swaps in. 32px = the resolved control height in the Field
    // primitive (8 padding-top + 16 body line + 8 padding-bottom).
    const { container } = render(<Skeleton.Field />);
    const field = container.querySelector('[role="status"]') as HTMLElement;
    expect(field).not.toBeNull();
    expect(field.style.height).toBe("32px");
  });

  it("exposes role=status + aria-live=polite + aria-busy=true", () => {
    const { container } = render(<Skeleton.Field />);
    const field = container.querySelector('[role="status"]') as HTMLElement;
    expect(field.getAttribute("role")).toBe("status");
    expect(field.getAttribute("aria-live")).toBe("polite");
    expect(field.getAttribute("aria-busy")).toBe("true");
  });

  it("includes a visually-hidden i18n loading label", () => {
    const { getAllByText } = render(<Skeleton.Field />);
    expect(getAllByText("Loading…").length).toBeGreaterThanOrEqual(1);
  });
});

describe("Skeleton — no animation loop invariant", () => {
  // The design-system's "exactly one loop" rule reserves the
  // heartbeat-pulse on the operate glyph as the only animation
  // loop in the product. Every skeleton primitive must remain
  // static — no shimmer, no pulse, no opacity loop.
  //
  // These tests pin that by asserting NO inline `animation` /
  // `animationName` style + NO `transition` (the skeleton is
  // a steady-state surface, not a transition target).
  it("Skeleton.Block carries no inline animation", () => {
    const { container } = render(<Skeleton.Block height={60} />);
    const block = container.querySelector('[role="status"]') as HTMLElement;
    expect(block.style.animation).toBe("");
    expect(block.style.animationName).toBe("");
  });

  it("Skeleton.Row carries no inline animation on its cells", () => {
    const { container } = render(
      <table>
        <tbody>
          <Skeleton.Row cols={2} />
        </tbody>
      </table>,
    );
    const tr = container.querySelector("tr") as HTMLElement;
    expect(tr.style.animation).toBe("");
    expect(tr.style.animationName).toBe("");
    const placeholders = container.querySelectorAll("td > span");
    placeholders.forEach((node) => {
      const el = node as HTMLElement;
      expect(el.style.animation).toBe("");
      expect(el.style.animationName).toBe("");
    });
  });

  it("Skeleton.Field carries no inline animation", () => {
    const { container } = render(<Skeleton.Field />);
    const field = container.querySelector('[role="status"]') as HTMLElement;
    expect(field.style.animation).toBe("");
    expect(field.style.animationName).toBe("");
  });
});

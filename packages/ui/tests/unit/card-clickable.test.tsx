/**
 * Card clickable affordance — PR-C5 (wave-16, phase-a appendix #16).
 *
 * The default Card renders a `<div>` surface with no hover, no
 * focus ring, no semantics. When `clickable` is true the Card
 * upgrades to a `<button type="button">` and inherits the same
 * 60ms ease-transform hover recipe used by `<Btn>` (background-
 * color + border-color shift, no shadow, no scale, no inversion).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";

import { Card } from "../../src/components/Card.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_CSS = readFileSync(
  resolve(__dirname, "../../src/styles/app.css"),
  "utf-8",
);

describe("Card — default (non-clickable)", () => {
  it("renders as <div> when clickable is not set", () => {
    const { container } = render(<Card>body</Card>);
    const root = container.firstChild as HTMLElement;
    expect(root.tagName.toLowerCase()).toBe("div");
  });

  it("does NOT carry the hover class when not clickable", () => {
    const { container } = render(<Card>body</Card>);
    const root = container.firstChild as HTMLElement;
    expect(root.className).not.toContain("opencoo-hover-card");
  });

  it("does NOT set cursor:pointer when not clickable", () => {
    const { container } = render(<Card>body</Card>);
    const root = container.firstChild as HTMLElement;
    expect(root.style.cursor).not.toBe("pointer");
  });
});

describe("Card — clickable", () => {
  it("renders as <button type=button> when clickable is true", () => {
    const { container } = render(
      <Card clickable onClick={() => undefined}>body</Card>,
    );
    const root = container.firstChild as HTMLElement;
    expect(root.tagName.toLowerCase()).toBe("button");
    expect(root.getAttribute("type")).toBe("button");
  });

  it("carries the opencoo-hover-card class so :hover can attach", () => {
    const { container } = render(
      <Card clickable onClick={() => undefined}>body</Card>,
    );
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain("opencoo-hover-card");
  });

  it("wires onClick through", () => {
    const onClick = vi.fn();
    const { container } = render(
      <Card clickable onClick={onClick}>body</Card>,
    );
    const root = container.firstChild as HTMLElement;
    fireEvent.click(root);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("sets cursor:pointer", () => {
    const { container } = render(
      <Card clickable onClick={() => undefined}>body</Card>,
    );
    const root = container.firstChild as HTMLElement;
    expect(root.style.cursor).toBe("pointer");
  });

  it("renders title + subtitle the same way as a non-clickable Card", () => {
    const { getByText } = render(
      <Card clickable onClick={() => undefined} title="T" subtitle="s">
        body
      </Card>,
    );
    expect(getByText("T")).not.toBeNull();
    expect(getByText("s")).not.toBeNull();
    expect(getByText("body")).not.toBeNull();
  });
});

describe("Card — CSS recipe (parsed from app.css)", () => {
  it("declares :hover for opencoo-hover-card with explicit per-property transitions", () => {
    const base = extractRuleBlock(APP_CSS, ".opencoo-hover-card");
    expect(base, "missing .opencoo-hover-card rule").not.toBeNull();
    expect(base).toMatch(/transition:\s*[^;]*background-color[^;]*/);
    expect(base).toMatch(/transition:\s*[^;]*border-color[^;]*/);
    expect(base).not.toMatch(/transition:\s*all\b/);
    expect(base).not.toMatch(/transition:[^;]*\btransform\s*[,;\n]/);
    expect(base).not.toMatch(/transition:[^;]*\bbox-shadow\b/);
    expect(base).toMatch(/60ms\s+var\(--ease-transform\)/);

    const hover = extractRuleBlock(APP_CSS, ".opencoo-hover-card:hover");
    expect(hover, "missing :hover for opencoo-hover-card").not.toBeNull();
    expect(hover).toMatch(/var\(--[a-z0-9-]+\)/);
    expect(hover).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

function extractRuleBlock(css: string, selector: string): string | null {
  const idx = css.indexOf(selector);
  if (idx < 0) return null;
  const open = css.indexOf("{", idx);
  if (open < 0) return null;
  let depth = 1;
  for (let i = open + 1; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

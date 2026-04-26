/**
 * DebugBanner tests — UX token-binding spec assertions.
 *
 * Pins:
 *   - banner does NOT render when `visible: false`
 *   - exact target copy when visible: chip `LLM_DEBUG_LOG=1` +
 *     prose + path-tail `llm_usage_debug`
 *   - operate ring-with-dot glyph rendered (NO emoji)
 *   - position is sticky (per spec)
 *   - NO close affordance — explicitly assert there is no
 *     element with role=button inside the banner
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { DebugBanner } from "../../src/components/DebugBanner.js";

describe("DebugBanner", () => {
  it("does NOT render when visible=false", () => {
    const { container } = render(<DebugBanner visible={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the exact target copy when visible=true (chip + prose + path-tail)", () => {
    render(<DebugBanner visible={true} />);
    const banner = screen.getByTestId("debug-banner");
    expect(banner.textContent).toContain("LLM_DEBUG_LOG=1");
    expect(banner.textContent).toContain("prompts and responses are mirroring to");
    expect(banner.textContent).toContain("llm_usage_debug");
  });

  it("includes the operate ring-with-dot glyph (NO emoji)", () => {
    render(<DebugBanner visible={true} />);
    const banner = screen.getByTestId("debug-banner");
    // The glyph has role=img with title=operate.
    expect(banner.querySelector("svg")).not.toBeNull();
    expect(banner.querySelector("title")?.textContent).toBe("operate");
    // Defensive — no emoji glyphs slipped in.
    expect(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}]/u.test(banner.textContent ?? "")).toBe(false);
  });

  it("is sticky-positioned (per spec)", () => {
    render(<DebugBanner visible={true} />);
    const banner = screen.getByTestId("debug-banner");
    expect(banner.style.position).toBe("sticky");
    expect(banner.style.top).toBe("0px");
  });

  it("renders NO close affordance — banner is not dismissible", () => {
    render(<DebugBanner visible={true} />);
    const banner = screen.getByTestId("debug-banner");
    // No buttons inside the banner.
    expect(banner.querySelector("button")).toBeNull();
  });
});

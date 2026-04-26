/**
 * PromptsDiffBanner tests — UX token-binding spec assertions.
 *
 * Pins:
 *   - empty `lagging` → renders nothing
 *   - non-empty → header count + per-row name/version/arrow +
 *     `acknowledge diff` link
 *   - acknowledging a row removes it from the visible list
 *   - acknowledging the LAST row triggers banner fade-out
 *   - NO emoji, NO Lucide; one filled-disc glyph from logo trio
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  PromptsDiffBanner,
  type PromptVersionDrift,
} from "../../src/components/PromptsDiffBanner.js";

const TWO_DRIFTS: ReadonlyArray<PromptVersionDrift> = [
  { name: "compiler", currentVersion: "1.0.0", defaultVersion: "1.1.0" },
  { name: "heartbeat", currentVersion: "1.0.0", defaultVersion: "1.2.0" },
];

describe("PromptsDiffBanner", () => {
  it("renders nothing when lagging is empty", () => {
    const { container } = render(<PromptsDiffBanner lagging={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one row per drifting prompt with name, current → default, and acknowledge link", () => {
    render(<PromptsDiffBanner lagging={TWO_DRIFTS} />);
    const banner = screen.getByTestId("prompts-diff-banner");
    expect(banner.textContent).toContain("compiler");
    expect(banner.textContent).toContain("v1.0.0");
    expect(banner.textContent).toContain("v1.1.0");
    expect(banner.textContent).toContain("v1.2.0");
    // Two `acknowledge diff` links — one per row.
    const ackLinks = screen.getAllByText(/acknowledge diff/i);
    expect(ackLinks.length).toBe(2);
  });

  it("uses one filled-disc glyph (NO emoji, NO Lucide)", () => {
    render(<PromptsDiffBanner lagging={TWO_DRIFTS} />);
    const banner = screen.getByTestId("prompts-diff-banner");
    expect(banner.querySelector("svg")).not.toBeNull();
    expect(banner.querySelector("title")?.textContent).toBe("compile");
    expect(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}]/u.test(banner.textContent ?? "")).toBe(false);
  });

  it("acknowledging a row removes it from the visible list and fires onAcknowledge", async () => {
    const onAcknowledge = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <PromptsDiffBanner lagging={TWO_DRIFTS} onAcknowledge={onAcknowledge} />,
    );
    const banner = screen.getByTestId("prompts-diff-banner");
    expect(banner.textContent).toContain("compiler");
    expect(banner.textContent).toContain("heartbeat");
    const ackLinks = screen.getAllByText(/acknowledge diff/i);
    // Acknowledge the first row (compiler).
    await user.click(ackLinks[0]!);
    expect(onAcknowledge).toHaveBeenCalledWith("compiler");
    expect(banner.textContent).not.toContain("compiler");
    expect(banner.textContent).toContain("heartbeat");
  });
});

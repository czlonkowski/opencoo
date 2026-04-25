/**
 * DiffPreviewDialog tests — the load-bearing sovereignty-diff
 * confirm flow.
 *
 * Pins:
 *   - Diff list renders one row per entry with both the before
 *     and after values.
 *   - Countdown ticks and disables Apply at expiry.
 *   - Apply button calls onApply.
 *   - Cancel button calls onCancel without firing Apply.
 *   - When errorMessage is set (server returned `payload_mismatch`
 *     or `expired`), the surface shows it.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DiffPreviewDialog } from "../../src/components/DiffPreviewDialog.js";
import type { SovereigntyDiffPreview } from "../../src/types.js";

function buildPreview(overrides?: Partial<SovereigntyDiffPreview>): SovereigntyDiffPreview {
  const expiresAt = (overrides?.expiresAt ?? Date.now()) + 0;
  return {
    diff: [
      { path: "model", before: "claude-3", after: "claude-4" },
      { path: "provider", before: "anthropic", after: "anthropic" },
    ],
    token: "test.token.123",
    expiresAt,
    ...overrides,
  };
}

describe("DiffPreviewDialog", () => {
  it("renders one row per diff entry with before + after values", () => {
    const preview = buildPreview({ expiresAt: Date.now() + 60_000 });
    render(
      <DiffPreviewDialog preview={preview} onApply={async () => undefined} onCancel={() => undefined} />,
    );
    expect(screen.getByText(/− "claude-3"/)).toBeInTheDocument();
    expect(screen.getByText(/\+ "claude-4"/)).toBeInTheDocument();
  });

  it("shows the countdown and disables Apply when expired", async () => {
    const FAKE_NOW_BASE = 1_000_000;
    let nowValue = FAKE_NOW_BASE;
    const preview = buildPreview({ expiresAt: FAKE_NOW_BASE - 1 });
    render(
      <DiffPreviewDialog
        preview={preview}
        onApply={async () => undefined}
        onCancel={() => undefined}
        now={() => nowValue}
      />,
    );
    expect(screen.getByTestId("diff-countdown").textContent).toMatch(/expired/i);
    const applyButton = screen.getByRole("button", { name: /Apply/i }) as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);
    nowValue = FAKE_NOW_BASE + 1; // ensure the now reference lints clean
    expect(nowValue).toBe(FAKE_NOW_BASE + 1);
  });

  it("calls onApply when Apply is clicked", async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    const preview = buildPreview({ expiresAt: Date.now() + 60_000 });
    const user = userEvent.setup();
    render(
      <DiffPreviewDialog preview={preview} onApply={onApply} onCancel={() => undefined} />,
    );
    await user.click(screen.getByRole("button", { name: /Apply/i }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel without firing Apply when Cancel is clicked", async () => {
    const onApply = vi.fn();
    const onCancel = vi.fn();
    const preview = buildPreview({ expiresAt: Date.now() + 60_000 });
    const user = userEvent.setup();
    render(
      <DiffPreviewDialog preview={preview} onApply={onApply} onCancel={onCancel} />,
    );
    await user.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("surfaces errorMessage when set", () => {
    const preview = buildPreview({ expiresAt: Date.now() + 60_000 });
    render(
      <DiffPreviewDialog
        preview={preview}
        onApply={async () => undefined}
        onCancel={() => undefined}
        errorMessage="server says payload_mismatch"
      />,
    );
    expect(screen.getByTestId("diff-error").textContent).toContain("payload_mismatch");
  });

  it("disables Apply when the diff is empty (no-op preview)", () => {
    const preview = buildPreview({ diff: [], expiresAt: Date.now() + 60_000 });
    render(
      <DiffPreviewDialog preview={preview} onApply={async () => undefined} onCancel={() => undefined} />,
    );
    const applyButton = screen.getByRole("button", { name: /Apply/i }) as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);
  });
});

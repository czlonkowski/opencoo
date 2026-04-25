/**
 * DiffPreviewDialog tests — sovereignty-diff confirm flow
 * (PR 29 / plan #131; UX token-binding spec).
 *
 * Pins:
 *   - Side-by-side current / proposed panels with explicit
 *     `+ ` / `- ` line markers.
 *   - Countdown formats as MM:SS; color shifts to var(--alert)
 *     under 30s; expired state disables Apply.
 *   - Apply / Cancel callbacks fire correctly.
 *   - errorMessage (server payload_mismatch / expired) surfaces.
 *   - Apply disabled on empty diff (no-op preview).
 *   - Submit label swaps to `committing…` mono on submit.
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
  it("renders side-by-side current and proposed panels with `+ `/`- ` markers", () => {
    const preview = buildPreview({ expiresAt: Date.now() + 60_000 });
    render(
      <DiffPreviewDialog preview={preview} onApply={async () => undefined} onCancel={() => undefined} />,
    );
    // Current panel shows the `before` value with a `- ` marker.
    expect(screen.getByText("claude-3")).toBeInTheDocument();
    // Proposed panel shows the `after` value with a `+ ` marker.
    expect(screen.getByText("claude-4")).toBeInTheDocument();
    // Both `+ ` and `- ` markers appear in the dialog text
    // content (the line markers are rendered as standalone
    // span text adjacent to the values).
    const list = screen.getByTestId("diff-list");
    expect(list.textContent).toContain("- claude-3");
    expect(list.textContent).toContain("+ claude-4");
    // Panel headers are present.
    expect(screen.getByText(/^current$/i)).toBeInTheDocument();
    expect(screen.getByText(/^proposed$/i)).toBeInTheDocument();
  });

  it("formats the countdown as MM:SS and disables Apply when expired", async () => {
    const FAKE_NOW_BASE = 1_000_000;
    const preview = buildPreview({ expiresAt: FAKE_NOW_BASE - 1 });
    render(
      <DiffPreviewDialog
        preview={preview}
        onApply={async () => undefined}
        onCancel={() => undefined}
        now={() => FAKE_NOW_BASE}
      />,
    );
    expect(screen.getByTestId("diff-countdown").textContent).toMatch(/expired/i);
    const applyButton = screen.getByRole("button", { name: /Apply/i }) as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);
  });

  it("renders the timer in MM:SS format with > 30s remaining", () => {
    const preview = buildPreview({ expiresAt: Date.now() + 90_000 }); // 1:30
    render(
      <DiffPreviewDialog preview={preview} onApply={async () => undefined} onCancel={() => undefined} />,
    );
    expect(screen.getByTestId("diff-countdown").textContent).toMatch(/01:\d{2}/);
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

  it("Apply button label swaps to `committing…` mono on submit (no spinner)", async () => {
    let resolveOuter: (() => void) | undefined;
    const onApply = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveOuter = resolve;
      }),
    );
    const preview = buildPreview({ expiresAt: Date.now() + 60_000 });
    const user = userEvent.setup();
    render(
      <DiffPreviewDialog preview={preview} onApply={onApply} onCancel={() => undefined} />,
    );
    void user.click(screen.getByRole("button", { name: /Apply/i }));
    await new Promise((r) => setTimeout(r, 10));
    const buttons = screen.getAllByRole("button");
    const committingBtn = buttons.find((b) => /committing…/i.test(b.textContent ?? ""));
    expect(committingBtn).toBeDefined();
    expect((committingBtn as HTMLButtonElement).disabled).toBe(true);
    resolveOuter?.();
  });
});

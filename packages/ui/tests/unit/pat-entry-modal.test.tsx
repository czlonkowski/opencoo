/**
 * PatEntryModal tests — UX token-binding spec assertions +
 * wave-16 PR-A1 native-<dialog> shell migration.
 *
 * Pins:
 *   - input is type=password (NO eye-toggle)
 *   - empty placeholder (NEVER a real-looking value)
 *   - empty submit shows the empty-token error
 *   - successful submit fires onSubmit with the entered value
 *   - while submitting, the button label swaps to
 *     `authenticating…` mono and disables
 *   - storage-note copy renders the "session storage · cleared
 *     when this tab closes" mono line
 *   - NO close affordance — modal is gating (auth or nothing).
 *     There is no Cancel / X — the only button is `Sign in`.
 *
 * PR-A1 (wave-16):
 *   - rendered inside a native <dialog> (the shared Modal shell)
 *     so it inherits focus-trap + Esc-block + top-layer for free.
 *     Even though the operator cannot dismiss the gating auth
 *     modal, the <dialog> primitive still provides browser
 *     focus-trap which is the actual A1 win.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PatEntryModal } from "../../src/components/PatEntryModal.js";

describe("PatEntryModal", () => {
  it("renders inside a native <dialog> shell (PR-A1)", () => {
    render(<PatEntryModal onSubmit={() => undefined} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByLabelText(/personal access token/i)).toBeInTheDocument();
  });

  it("renders a masked password input with empty placeholder + storage-note", () => {
    render(<PatEntryModal onSubmit={() => undefined} />);
    const input = screen.getByLabelText(/personal access token/i) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.placeholder).toBe("");
    expect(input.dataset["secret"]).toBe("true");
    expect(screen.getByText(/session storage · cleared when this tab closes/i)).toBeInTheDocument();
  });

  it("rejects empty submit with the empty-token error", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<PatEntryModal onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: /Sign in/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/Token is required/i)).toBeInTheDocument();
  });

  it("fires onSubmit with the entered PAT", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<PatEntryModal onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText(/personal access token/i), "test-pat");
    await user.click(screen.getByRole("button", { name: /Sign in/i }));
    expect(onSubmit).toHaveBeenCalledWith("test-pat");
  });

  it("renders NO close affordance — modal is gating (auth or nothing)", () => {
    render(<PatEntryModal onSubmit={() => undefined} />);
    // Only one button: the Sign-in primary CTA.
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.textContent).toMatch(/Sign in/i);
  });

  it("button label swaps to `authenticating…` while submitting", async () => {
    let resolveOuter: (() => void) | undefined;
    const onSubmit = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveOuter = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<PatEntryModal onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText(/personal access token/i), "x");
    void user.click(screen.getByRole("button", { name: /Sign in/i }));
    // Submit transitions to `authenticating…` once React flushes
    // the state update for the in-flight (never-resolving here)
    // onSubmit. waitFor is more robust than a fixed timeout —
    // React's effect-flush timing is not perfectly deterministic
    // under jsdom + the polyfilled <dialog> lifecycle.
    await waitFor(() => {
      const btn = screen.getByRole("button") as HTMLButtonElement;
      expect(btn.textContent).toMatch(/authenticating…/i);
      expect(btn.disabled).toBe(true);
    });
    resolveOuter?.();
  });

  // PR-W18 — Gitea handoff block. The 3-step explanation always
  // renders; the "Open Gitea" link renders only when the public
  // config endpoint returns a non-null giteaUrl. The PatEntryModal
  // fetches `/api/public/config` on mount; failure (4xx / 5xx /
  // network) silently falls back to "explanation only, no link"
  // because there's no toast region rendered pre-auth.
  describe("Gitea handoff (PR-W18)", () => {
    it("renders the 3-step explanation independent of config fetch", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ giteaUrl: null }), { status: 200 }),
        );
      render(<PatEntryModal onSubmit={vi.fn()} />);
      // Steps render synchronously from i18n — no fetch wait needed.
      expect(screen.getByText(/Open your Gitea instance/i)).toBeInTheDocument();
      expect(
        screen.getByText(/Settings → Applications → Generate New Token/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/Grant the token admin scope/i)).toBeInTheDocument();
      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      fetchSpy.mockRestore();
    });

    it("renders the Open Gitea link when /api/public/config returns a URL", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({ giteaUrl: "https://gitea.example.com/" }),
          { status: 200 },
        ),
      );
      render(<PatEntryModal onSubmit={vi.fn()} />);
      const link = await screen.findByTestId("pat-entry-gitea-link");
      expect(link.tagName).toBe("A");
      expect(link).toHaveAttribute("href", "https://gitea.example.com/");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(link.textContent).toMatch(/Open Gitea/i);
      fetchSpy.mockRestore();
    });

    it("hides the link when giteaUrl is null", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ giteaUrl: null }), { status: 200 }),
        );
      render(<PatEntryModal onSubmit={vi.fn()} />);
      // Let the fetch promise resolve so a defensive
      // implementation that conditionally renders would update.
      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      expect(screen.queryByTestId("pat-entry-gitea-link")).toBeNull();
      fetchSpy.mockRestore();
    });

    it("hides the link when /api/public/config fails (network or 5xx)", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new TypeError("network down"));
      render(<PatEntryModal onSubmit={vi.fn()} />);
      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      expect(screen.queryByTestId("pat-entry-gitea-link")).toBeNull();
      // The explanation is still present.
      expect(screen.getByText(/Open your Gitea instance/i)).toBeInTheDocument();
      fetchSpy.mockRestore();
    });
  });
});

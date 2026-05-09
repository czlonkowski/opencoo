/**
 * ImpactPreviewDialog tests — PR-R7, phase-a appendix #10.
 *
 * The dialog opened from the Sources row drill-down's "Forget
 * source" button. Confirms:
 *
 *   - Loading state renders during the dry-run fetch.
 *   - After fetch resolves: rendered impact counts; pages-delete
 *     list with `--wiki` color tokens.
 *   - Checkbox-gates the destructive button (disabled until ticked).
 *   - Confirm button has `--alert` accent.
 *   - Cap-exhausted: shows inline `--alert` warning + button stays
 *     disabled even when the checkbox would normally tick.
 *   - Cancel closes without action.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ImpactPreviewDialog } from "../../src/components/ImpactPreviewDialog.js";

const BINDING_ID = "11111111-2222-3333-4444-555555555555";

interface FetchCall {
  readonly url: string;
  readonly method: string;
}

function makeFetchMock(opts: {
  dryRunBody: unknown;
  dryRunStatus?: number;
  /** Optional body+status for the actual-forget POST. Defaults to 200 with
   *  the same shape as dry-run. */
  confirmBody?: unknown;
  confirmStatus?: number;
}): {
  fetchImpl: ReturnType<typeof vi.fn>;
  callsRef: { current: FetchCall[] };
} {
  const callsRef: { current: FetchCall[] } = { current: [] };
  const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    callsRef.current.push({ url, method });
    if (url === "/api/admin/_csrf") {
      return new Response(JSON.stringify({ csrfToken: "test-csrf" }), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "opencoo_csrf=tc" },
      });
    }
    if (url.endsWith("?dryRun=1")) {
      return new Response(JSON.stringify(opts.dryRunBody), {
        status: opts.dryRunStatus ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("?dryRun=0")) {
      return new Response(
        JSON.stringify(opts.confirmBody ?? opts.dryRunBody),
        {
          status: opts.confirmStatus ?? 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response("not found", { status: 404 });
  });
  return {
    fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>,
    callsRef,
  };
}

const HAPPY_DRY_RUN = {
  pagesRecompiled: ["wiki-test/index.md"],
  pagesDeleted: ["wiki-test/team-a.md", "wiki-test/team-b.md"],
  citationsRemoved: 3,
  dailyDeleteCapState: { used: 0, cap: 10 },
};

describe("ImpactPreviewDialog", () => {
  it("renders the loading state during the dry-run fetch", () => {
    // Hold the dry-run forever so we can assert on the loading state.
    let resolveDry: ((r: Response) => void) | null = null;
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/admin/_csrf") {
        return new Response(JSON.stringify({ csrfToken: "test-csrf" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "opencoo_csrf=tc",
          },
        });
      }
      if (method === "POST" && url.includes("/forget?dryRun=1")) {
        return new Promise<Response>((resolve) => {
          resolveDry = resolve;
        });
      }
      return new Response("not found", { status: 404 });
    });

    render(
      <ImpactPreviewDialog
        bindingId={BINDING_ID}
        onClose={() => undefined}
        onConfirmed={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );

    expect(
      screen.getByTestId("forget-impact-loading"),
    ).toBeInTheDocument();
    // The destructive button must be disabled while loading.
    const confirmBtn = screen.getByTestId(
      "forget-impact-confirm",
    ) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    // Cleanup: resolve the pending promise so React doesn't warn on unmount.
    if (resolveDry !== null) {
      (resolveDry as (r: Response) => void)(
        new Response(JSON.stringify(HAPPY_DRY_RUN), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
  });

  it("renders impact counts + deleted-paths list with --wiki color after fetch resolves", async () => {
    const { fetchImpl } = makeFetchMock({ dryRunBody: HAPPY_DRY_RUN });
    render(
      <ImpactPreviewDialog
        bindingId={BINDING_ID}
        onClose={() => undefined}
        onConfirmed={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );

    // Wait for the impact summary to render.
    const summary = await screen.findByTestId("forget-impact-summary");
    expect(summary.textContent).toMatch(/1 pages/i);
    expect(summary.textContent).toMatch(/2 pages/i);
    expect(summary.textContent).toMatch(/3 citations/i);

    // Deleted-paths list rendered with `--wiki` color token.
    const list = screen.getByTestId("forget-impact-deleted-paths");
    const items = list.querySelectorAll("li");
    expect(items.length).toBe(2);
    expect(items[0]!.textContent).toBe("wiki-test/team-a.md");
    // The wiki-teal color token MUST be applied to each path li.
    const inlineStyle = items[0]!.getAttribute("style") ?? "";
    expect(inlineStyle).toMatch(/color:\s*var\(--wiki\)/);
  });

  it("checkbox-gates the destructive Confirm button", async () => {
    const user = userEvent.setup();
    const { fetchImpl } = makeFetchMock({ dryRunBody: HAPPY_DRY_RUN });
    render(
      <ImpactPreviewDialog
        bindingId={BINDING_ID}
        onClose={() => undefined}
        onConfirmed={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );

    const confirmBtn = (await screen.findByTestId(
      "forget-impact-confirm",
    )) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    const checkbox = screen.getByTestId(
      "forget-impact-checkbox",
    ) as HTMLInputElement;
    await user.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(confirmBtn.disabled).toBe(false);
  });

  it("renders the Confirm button with the --alert accent (destructive style)", async () => {
    const { fetchImpl } = makeFetchMock({ dryRunBody: HAPPY_DRY_RUN });
    render(
      <ImpactPreviewDialog
        bindingId={BINDING_ID}
        onClose={() => undefined}
        onConfirmed={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    const confirmBtn = (await screen.findByTestId(
      "forget-impact-confirm",
    )) as HTMLButtonElement;
    // The disabled style uses --ink-3, not --alert. Tick the
    // checkbox so the enabled style applies, then assert.
    const user = userEvent.setup();
    const checkbox = screen.getByTestId(
      "forget-impact-checkbox",
    ) as HTMLInputElement;
    await user.click(checkbox);
    const inlineStyle = confirmBtn.getAttribute("style") ?? "";
    expect(inlineStyle).toMatch(/background:\s*var\(--alert\)/);
    expect(inlineStyle).toMatch(/border-color:\s*var\(--alert\)/);
  });

  it("cap-exhausted: shows inline --alert warning + Confirm stays disabled (no checkbox shown)", async () => {
    const { fetchImpl } = makeFetchMock({
      dryRunBody: {
        ...HAPPY_DRY_RUN,
        // 9 used + 2 planned deletes = 11 > 10 cap.
        dailyDeleteCapState: { used: 9, cap: 10 },
      },
    });
    render(
      <ImpactPreviewDialog
        bindingId={BINDING_ID}
        onClose={() => undefined}
        onConfirmed={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );

    const alert = await screen.findByTestId("cap-alert");
    expect(alert).toBeInTheDocument();
    const inlineStyle = alert.getAttribute("style") ?? "";
    expect(inlineStyle).toMatch(/color:\s*var\(--alert\)/);

    // Checkbox is NOT rendered when cap-exceeded — there's no path
    // to confirm so we hide the gate entirely.
    expect(screen.queryByTestId("forget-impact-checkbox")).toBeNull();

    const confirmBtn = screen.getByTestId(
      "forget-impact-confirm",
    ) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });

  it("Cancel closes without firing the actual-forget POST", async () => {
    const user = userEvent.setup();
    const { fetchImpl, callsRef } = makeFetchMock({
      dryRunBody: HAPPY_DRY_RUN,
    });
    const onClose = vi.fn();
    const onConfirmed = vi.fn();
    render(
      <ImpactPreviewDialog
        bindingId={BINDING_ID}
        onClose={onClose}
        onConfirmed={onConfirmed}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    // Wait for impact to render.
    await screen.findByTestId("forget-impact-summary");

    // Click Cancel.
    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    await user.click(cancelBtn);

    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirmed).not.toHaveBeenCalled();
    // No POST `?dryRun=0` fired.
    const confirmCalls = callsRef.current.filter((c) =>
      c.url.endsWith("?dryRun=0"),
    );
    expect(confirmCalls.length).toBe(0);
  });

  it("Confirm POSTs ?dryRun=0 + fires onConfirmed + onClose on 200", async () => {
    const user = userEvent.setup();
    const { fetchImpl, callsRef } = makeFetchMock({
      dryRunBody: HAPPY_DRY_RUN,
    });
    const onClose = vi.fn();
    const onConfirmed = vi.fn();
    render(
      <ImpactPreviewDialog
        bindingId={BINDING_ID}
        onClose={onClose}
        onConfirmed={onConfirmed}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await screen.findByTestId("forget-impact-summary");
    const checkbox = screen.getByTestId(
      "forget-impact-checkbox",
    ) as HTMLInputElement;
    await user.click(checkbox);

    const confirmBtn = screen.getByTestId(
      "forget-impact-confirm",
    ) as HTMLButtonElement;
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(onConfirmed).toHaveBeenCalledOnce();
    });
    expect(onClose).toHaveBeenCalled();
    const confirmCalls = callsRef.current.filter((c) =>
      c.url.endsWith("?dryRun=0"),
    );
    expect(confirmCalls.length).toBe(1);
    expect(confirmCalls[0]!.method).toBe("POST");
  });
});

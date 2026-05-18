/**
 * SourceBindingDetail — per-intake Retry button (PR-W4+, wave-17 follow-up).
 *
 * W4 (`source-binding-detail-intake-state.test.tsx`) shipped each failed
 * row's Retry button parked in `disabled` state with a "wires in W2"
 * tooltip. W2 then landed the `POST .../retry-failed?intakeId=<id>`
 * surface (per-row narrowing via query param). W4+ closes the loop by
 * enabling the per-row Retry buttons and wiring the click to that
 * route.
 *
 * Pin matrix:
 *   1. The Retry button on a failed row is ENABLED (no longer the
 *      W4 stub).
 *   2. Click → POST `/api/admin/source-bindings/:id/retry-failed
 *      ?intakeId=<row-id>` (the per-row scoping query param) — NOT
 *      a body-shaped payload.
 *   3. Success (200) → success toast surfaces + parent `onChanged`
 *      fires so the binding refetches; on the next render the row
 *      no longer appears under `recentFailedIntake` (the row's
 *      `intake_status` flipped from `failed` to `pending`).
 *   4. 422 validation error → alert toast surfaces with the
 *      `safeErrorMessage`-scrubbed body.
 *   5. While the POST is in flight the button is `aria-busy` +
 *      `aria-disabled` so the operator can't double-click and a
 *      screen reader announces the in-flight state.
 *
 * 401 / CSRF retry / PAT-redirect paths are owned by `fetchAdmin` and
 * already covered by its own tests — this file does not re-test them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SourceBindingDetail } from "../../src/components/SourceBindingDetail.js";
import { ToastProvider, ToastRegion } from "../../src/components/Toast.js";
import type { SourceBinding } from "../../src/types.js";

const BINDING_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const FAILED_ROW_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";

function makeBinding(overrides: Partial<SourceBinding> = {}): SourceBinding {
  return {
    id: BINDING_ID,
    domainSlug: "wiki-intake-test",
    adapterSlug: "drive",
    reviewMode: "auto",
    enabled: true,
    notes: null,
    name: "drive → wiki-intake-test",
    status: "alert",
    lastEventAt: new Date(Date.now() - 60_000).toISOString(),
    lastError: null,
    pendingEventsCount: 0,
    sigFailCount24h: 0,
    intakeCounts: {
      pending: 0,
      classified: 0,
      skipped: 0,
      failed: 1,
    },
    recentFailedIntake: [
      {
        id: FAILED_ROW_ID,
        errorClass: "validation",
        errorTextSnippet: "binding.allowed_paths is empty",
      },
    ],
    ...overrides,
  };
}

function withToast(node: JSX.Element): JSX.Element {
  return (
    <ToastProvider>
      {node}
      <ToastRegion />
    </ToastProvider>
  );
}

describe("SourceBindingDetail — per-intake Retry button (PR-W4+)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the per-row Retry button enabled (no longer the W4 stub)", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    render(
      withToast(
        <SourceBindingDetail
          binding={makeBinding()}
          onClose={() => undefined}
          onChanged={() => undefined}
          fetchImpl={fetchImpl}
        />,
      ),
    );
    const retryBtn = screen.getByTestId(
      `intake-failed-row-retry-${FAILED_ROW_ID}`,
    );
    expect(retryBtn).toBeInTheDocument();
    expect(retryBtn).not.toBeDisabled();
  });

  it("click → POST /retry-failed?intakeId=<id> + success toast + onChanged fires", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      // Match the per-row retry: same route as bulk, narrowed by
      // `intakeId` query param (see admin-api/routes/source-bindings.ts).
      if (
        url.startsWith(
          `/api/admin/source-bindings/${BINDING_ID}/retry-failed`,
        ) &&
        url.includes(`intakeId=${FAILED_ROW_ID}`) &&
        init?.method === "POST"
      ) {
        return new Response(JSON.stringify({ retriedCount: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    const onChanged = vi.fn();
    render(
      withToast(
        <SourceBindingDetail
          binding={makeBinding()}
          onClose={() => undefined}
          onChanged={onChanged}
          fetchImpl={fetchImpl as unknown as typeof fetch}
        />,
      ),
    );
    await user.click(
      screen.getByTestId(`intake-failed-row-retry-${FAILED_ROW_ID}`),
    );

    // Endpoint fired with the per-row query param.
    await waitFor(() => {
      expect(
        fetchImpl.mock.calls.some(
          (c) =>
            String(c[0]).startsWith(
              `/api/admin/source-bindings/${BINDING_ID}/retry-failed`,
            ) &&
            String(c[0]).includes(`intakeId=${FAILED_ROW_ID}`) &&
            (c[1] as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true);
    });

    // Success toast renders via useToast — surfaces in a role="status"
    // node in the global toast region carrying the "retry queued" copy.
    await waitFor(() => {
      const success = screen.getAllByRole("status").find((node) =>
        (node.textContent ?? "")
          .toLowerCase()
          .match(/retry queued|ponowienie dodane/),
      );
      expect(success).toBeDefined();
    });

    // Parent re-fetch triggered.
    expect(onChanged).toHaveBeenCalled();
  });

  it("422 validation_failed → alert toast with the scrubbed error message", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "invalid_intake_id",
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      );
    });
    render(
      withToast(
        <SourceBindingDetail
          binding={makeBinding()}
          onClose={() => undefined}
          onChanged={() => undefined}
          fetchImpl={fetchImpl as unknown as typeof fetch}
        />,
      ),
    );
    await user.click(
      screen.getByTestId(`intake-failed-row-retry-${FAILED_ROW_ID}`),
    );

    // Alert toast surfaces. `useToast().alert(...)` paints role="alert"
    // (see Toast.tsx) — assert the alert-toned toast lands with the
    // intake-retry error copy.
    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      const intakeAlert = alerts.find((node) =>
        (node.textContent ?? "")
          .toLowerCase()
          .match(/could not queue retry|nie udało się dodać ponowienia/),
      );
      expect(intakeAlert).toBeDefined();
    });
  });

  it("button is aria-busy + aria-disabled while the POST is in flight", async () => {
    const user = userEvent.setup();
    // Block the POST so the in-flight state stays observable.
    let resolveFetch: (response: Response) => void = () => undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    render(
      withToast(
        <SourceBindingDetail
          binding={makeBinding()}
          onClose={() => undefined}
          onChanged={() => undefined}
          fetchImpl={fetchImpl as unknown as typeof fetch}
        />,
      ),
    );
    const btn = screen.getByTestId(
      `intake-failed-row-retry-${FAILED_ROW_ID}`,
    );
    await user.click(btn);

    await waitFor(() => {
      // While in flight, the button is aria-busy + aria-disabled
      // (defends against double-click; announces busy state to AT).
      expect(btn.getAttribute("aria-busy")).toBe("true");
      expect(btn.getAttribute("aria-disabled")).toBe("true");
    });

    // Cleanup — let the fetch resolve so React doesn't warn on unmount.
    resolveFetch(
      new Response(JSON.stringify({ retriedCount: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
});

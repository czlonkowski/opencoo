/**
 * SourceBindingDetail — AllowedPathsPanel (PR-W1 of phase-a
 * appendix #14).
 *
 * Pins:
 *   1. Renders the binding's `allowedPaths` as chips.
 *   2. Clicking "Edit" reveals a draft editor with remove + add
 *      affordances.
 *   3. Save dispatches PATCH `/api/admin/source-bindings/:id` with
 *      `{allowed_paths: [...]}` and triggers `onChanged`.
 *   4. Save blocked when the draft list is empty.
 *   5. Save blocked when a draft pattern is wildcard-shaped.
 *   6. Cancel restores the persisted list.
 *   7. Panel hidden when the binding has no `allowedPaths` field
 *      (backward-compat with pre-W1 fixtures).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SourceBindingDetail } from "../../src/components/SourceBindingDetail.js";
import type { SourceBinding } from "../../src/types.js";

const BINDING_ID = "aaaa1111-2222-3333-4444-555555555555";

function makeBinding(overrides: Partial<SourceBinding> = {}): SourceBinding {
  return {
    id: BINDING_ID,
    domainSlug: "wiki-test",
    adapterSlug: "drive",
    reviewMode: "auto",
    enabled: true,
    notes: null,
    name: "drive → wiki-test",
    status: "healthy",
    lastEventAt: null,
    lastError: null,
    pendingEventsCount: 0,
    sigFailCount24h: 0,
    allowedPaths: ["docs/**"],
    ...overrides,
  };
}

describe("SourceBindingDetail — AllowedPathsPanel (PR-W1)", () => {
  it("renders the binding's allowedPaths as chips", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    render(
      <SourceBindingDetail
        binding={makeBinding({
          allowedPaths: ["meetings/**", "transcripts/**", "docs/**"],
        })}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl}
      />,
    );
    expect(
      document.querySelector(
        "[data-testid='allowed-paths-chip-meetings/**']",
      ),
    ).not.toBeNull();
    expect(
      document.querySelector(
        "[data-testid='allowed-paths-chip-transcripts/**']",
      ),
    ).not.toBeNull();
    expect(
      document.querySelector("[data-testid='allowed-paths-chip-docs/**']"),
    ).not.toBeNull();
  });

  it("Edit → add chip → Save dispatches PATCH with new list", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (
        url === `/api/admin/source-bindings/${BINDING_ID}` &&
        init?.method === "PATCH"
      ) {
        return new Response(
          JSON.stringify({
            id: BINDING_ID,
            allowed_paths: ["docs/**", "meetings/**"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    const onChanged = vi.fn();
    render(
      <SourceBindingDetail
        binding={makeBinding({ allowedPaths: ["docs/**"] })}
        onClose={() => undefined}
        onChanged={onChanged}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    // Find the Edit button inside the allowed_paths panel — disambiguates
    // from the page's other Edit (binding-config / credentials).
    const panel = document.querySelector(
      "[data-testid='allowed-paths-panel']",
    ) as HTMLElement;
    expect(panel).not.toBeNull();
    const editBtn = panel.querySelector("button")!;
    await user.click(editBtn);
    const input = document.querySelector(
      "[data-testid='allowed-paths-edit-input']",
    ) as HTMLInputElement;
    await user.type(input, "meetings/**");
    await user.keyboard("{Enter}");
    expect(
      document.querySelector("[data-testid='allowed-paths-chip-meetings/**']"),
    ).not.toBeNull();
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(
        fetchImpl.mock.calls.some(
          (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
        ),
      ).toBe(true),
    );
    const patchCall = fetchImpl.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
    )!;
    const body = JSON.parse(String((patchCall[1] as RequestInit).body));
    expect(body).toEqual({
      allowed_paths: ["docs/**", "meetings/**"],
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it("Save blocked when the draft list is empty", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(
      async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
        // Reference the args so eslint doesn't flag them as unused;
        // they're carried into mock.calls for the assertion below.
        void input;
        void init;
        return new Response("not found", { status: 404 });
      },
    );
    render(
      <SourceBindingDetail
        binding={makeBinding({ allowedPaths: ["docs/**"] })}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    const panel = document.querySelector(
      "[data-testid='allowed-paths-panel']",
    ) as HTMLElement;
    await user.click(panel.querySelector("button")!);
    // Remove the only chip then try to save.
    const removeBtn = screen.getByRole("button", { name: /remove docs\/\*\*/i });
    await user.click(removeBtn);
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(
      fetchImpl.mock.calls.some(
        (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
      ),
    ).toBe(false);
    // Inline error rendered.
    expect(screen.getByRole("alert").textContent).toBeTruthy();
  });

  it("Save blocked when a draft pattern is wildcard-shaped", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(
      async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
        // Reference the args so eslint doesn't flag them as unused;
        // they're carried into mock.calls for the assertion below.
        void input;
        void init;
        return new Response("not found", { status: 404 });
      },
    );
    render(
      <SourceBindingDetail
        binding={makeBinding({ allowedPaths: ["docs/**"] })}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    const panel = document.querySelector(
      "[data-testid='allowed-paths-panel']",
    ) as HTMLElement;
    await user.click(panel.querySelector("button")!);
    const input = document.querySelector(
      "[data-testid='allowed-paths-edit-input']",
    ) as HTMLInputElement;
    await user.type(input, "**");
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(
      fetchImpl.mock.calls.some(
        (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
      ),
    ).toBe(false);
  });

  it("Cancel restores the persisted list", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(
      async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
        // Reference the args so eslint doesn't flag them as unused;
        // they're carried into mock.calls for the assertion below.
        void input;
        void init;
        return new Response("not found", { status: 404 });
      },
    );
    render(
      <SourceBindingDetail
        binding={makeBinding({ allowedPaths: ["docs/**"] })}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    const panel = document.querySelector(
      "[data-testid='allowed-paths-panel']",
    ) as HTMLElement;
    await user.click(panel.querySelector("button")!);
    // Add a chip then cancel.
    const input = document.querySelector(
      "[data-testid='allowed-paths-edit-input']",
    ) as HTMLInputElement;
    await user.type(input, "meetings/**");
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    // The draft chip is gone — only the persisted chip renders.
    expect(
      document.querySelector("[data-testid='allowed-paths-chip-meetings/**']"),
    ).toBeNull();
    expect(
      document.querySelector("[data-testid='allowed-paths-chip-docs/**']"),
    ).not.toBeNull();
  });

  it("panel hidden when the binding has no allowedPaths field", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    // Force `allowedPaths` undefined to mirror pre-W1 fixtures.
    const binding = makeBinding();
    const stripped: SourceBinding = { ...binding };
    delete (stripped as { allowedPaths?: readonly string[] }).allowedPaths;
    render(
      <SourceBindingDetail
        binding={stripped}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl}
      />,
    );
    expect(
      document.querySelector("[data-testid='allowed-paths-panel']"),
    ).toBeNull();
  });
});

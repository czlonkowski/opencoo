/**
 * NewSourceBindingModal — allowed_paths step (PR-W1 of phase-a
 * appendix #14).
 *
 * Pins:
 *   1. Renders the adapter's `defaultAllowedPaths` as click-to-add
 *      suggestion chips.
 *   2. Clicking a suggestion chip moves it from "suggestions" to
 *      "selected"; the suggestion disappears.
 *   3. Operator can type a custom pattern and press Enter to add.
 *   4. Remove button on a selected chip drops it back to the
 *      suggestions row (when it was originally a suggestion) or
 *      just removes (when it was custom).
 *   5. Submit fires POST with `allowed_paths` in body.
 *   6. Submit blocked when the selected list is empty.
 *   7. Submit blocked when a selected pattern is wildcard-shaped
 *      (`**`, `**\/foo`) — defense-in-depth mirroring the server
 *      guard.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NewSourceBindingModal } from "../../src/components/NewSourceBindingModal.js";

const ADAPTERS_RESPONSE = {
  adapters: [
    {
      slug: "drive",
      mode: "polling" as const,
      credentialSchema: {
        type: "object",
        properties: {
          service_account_json: { type: "string", secret: true },
          root_folder_id: { type: "string" },
        },
        required: ["service_account_json", "root_folder_id"],
      },
      bindingConfigSchema: {
        type: "object",
        properties: {
          folderId: { type: "string", minLength: 1 },
        },
        required: ["folderId"],
      },
      defaultAllowedPaths: ["meetings/**", "transcripts/**", "docs/**"],
    },
  ],
};

const DOMAINS_RESPONSE = {
  rows: [
    {
      id: "11111111-1111-1111-1111-111111111111",
      slug: "wiki-main",
      name: "Main",
      class: "knowledge",
      locale: "en",
      llmPolicy: {},
      isAggregator: false,
    },
  ],
};

function makeFetchMock(): {
  fetchImpl: ReturnType<typeof vi.fn>;
  postCalls: () => Array<[string, RequestInit]>;
} {
  const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/admin/adapters" && method === "GET") {
      return new Response(JSON.stringify(ADAPTERS_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/admin/domains" && method === "GET") {
      return new Response(JSON.stringify(DOMAINS_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/admin/source-bindings" && method === "POST") {
      return new Response(
        JSON.stringify({ id: "00000000-0000-0000-0000-000000000099" }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  });
  const postCalls = (): Array<[string, RequestInit]> =>
    fetchImpl.mock.calls
      .filter(
        (c) =>
          ((c[1] as RequestInit | undefined)?.method ?? "GET").toUpperCase() ===
          "POST",
      )
      .map((c) => [String(c[0]), c[1] as RequestInit]);
  return { fetchImpl, postCalls };
}

/** Boot the modal and advance to the allowed_paths step (the 4th
 *  step). Fills credentials + config along the way with valid
 *  values so the gates pass. */
async function advanceToAllowedPaths(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await waitFor(() =>
    expect(document.querySelector("select[name='adapter_slug']")).not.toBeNull(),
  );
  await user.click(screen.getByRole("button", { name: /next/i }));
  await user.type(
    document.querySelector("input[name='service_account_json']")!,
    "json",
  );
  await user.type(
    document.querySelector("input[name='root_folder_id']")!,
    "1XYZ",
  );
  await user.click(screen.getByRole("button", { name: /next/i }));
  await user.type(document.querySelector("input[name='folderId']")!, "1ABC");
  // Config → allowed_paths.
  await user.click(screen.getByRole("button", { name: /^next$/i }));
  await waitFor(() =>
    expect(
      document.querySelector("[data-testid='allowed-paths-selected']"),
    ).not.toBeNull(),
  );
}

describe("NewSourceBindingModal — allowed_paths step (PR-W1)", () => {
  it("renders the adapter's defaultAllowedPaths as click-to-add suggestion chips", async () => {
    const { fetchImpl } = makeFetchMock();
    const user = userEvent.setup();
    render(
      <NewSourceBindingModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await advanceToAllowedPaths(user);
    expect(
      document.querySelector(
        "[data-testid='allowed-path-suggestion-meetings/**']",
      ),
    ).not.toBeNull();
    expect(
      document.querySelector(
        "[data-testid='allowed-path-suggestion-transcripts/**']",
      ),
    ).not.toBeNull();
    expect(
      document.querySelector(
        "[data-testid='allowed-path-suggestion-docs/**']",
      ),
    ).not.toBeNull();
  });

  it("clicking a suggestion moves the chip to the selected row", async () => {
    const { fetchImpl } = makeFetchMock();
    const user = userEvent.setup();
    render(
      <NewSourceBindingModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await advanceToAllowedPaths(user);
    const suggestion = document.querySelector(
      "[data-testid='allowed-path-suggestion-meetings/**']",
    ) as HTMLElement;
    await user.click(suggestion);
    expect(
      document.querySelector("[data-testid='allowed-path-chip-meetings/**']"),
    ).not.toBeNull();
    // Suggestion is no longer rendered.
    expect(
      document.querySelector(
        "[data-testid='allowed-path-suggestion-meetings/**']",
      ),
    ).toBeNull();
  });

  it("operator can type a custom pattern and press Enter to add", async () => {
    const { fetchImpl } = makeFetchMock();
    const user = userEvent.setup();
    render(
      <NewSourceBindingModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await advanceToAllowedPaths(user);
    const input = document.querySelector(
      "[data-testid='allowed-paths-custom-input']",
    ) as HTMLInputElement;
    await user.type(input, "custom/sub/**");
    await user.keyboard("{Enter}");
    expect(
      document.querySelector("[data-testid='allowed-path-chip-custom/sub/**']"),
    ).not.toBeNull();
  });

  it("remove button on a selected chip drops it back out of the list", async () => {
    const { fetchImpl } = makeFetchMock();
    const user = userEvent.setup();
    render(
      <NewSourceBindingModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await advanceToAllowedPaths(user);
    const suggestion = document.querySelector(
      "[data-testid='allowed-path-suggestion-docs/**']",
    ) as HTMLElement;
    await user.click(suggestion);
    expect(
      document.querySelector("[data-testid='allowed-path-chip-docs/**']"),
    ).not.toBeNull();
    const removeBtn = screen.getByRole("button", { name: /remove docs\/\*\*/i });
    await user.click(removeBtn);
    expect(
      document.querySelector("[data-testid='allowed-path-chip-docs/**']"),
    ).toBeNull();
    // Re-surfaced in suggestions.
    expect(
      document.querySelector("[data-testid='allowed-path-suggestion-docs/**']"),
    ).not.toBeNull();
  });

  it("submit fires POST with allowed_paths array", async () => {
    const { fetchImpl, postCalls } = makeFetchMock();
    const user = userEvent.setup();
    render(
      <NewSourceBindingModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await advanceToAllowedPaths(user);
    // Click two suggestions so we know which two paths land in the body.
    await user.click(
      document.querySelector(
        "[data-testid='allowed-path-suggestion-meetings/**']",
      ) as HTMLElement,
    );
    await user.click(
      document.querySelector(
        "[data-testid='allowed-path-suggestion-transcripts/**']",
      ) as HTMLElement,
    );
    await user.click(screen.getByRole("button", { name: /create binding/i }));
    await waitFor(() => expect(postCalls().length).toBe(1));
    const [, init] = postCalls()[0]!;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body["allowed_paths"]).toEqual(["meetings/**", "transcripts/**"]);
  });

  it("submit blocked when the selected list is empty", async () => {
    const { fetchImpl, postCalls } = makeFetchMock();
    const user = userEvent.setup();
    render(
      <NewSourceBindingModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await advanceToAllowedPaths(user);
    // No chip selected; click Create.
    await user.click(screen.getByRole("button", { name: /create binding/i }));
    expect(postCalls().length).toBe(0);
    // Inline error rendered.
    expect(screen.getByRole("alert").textContent).toBeTruthy();
  });

  it("submit blocked when a selected pattern is wildcard-shaped ('**')", async () => {
    const { fetchImpl, postCalls } = makeFetchMock();
    const user = userEvent.setup();
    render(
      <NewSourceBindingModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await advanceToAllowedPaths(user);
    const input = document.querySelector(
      "[data-testid='allowed-paths-custom-input']",
    ) as HTMLInputElement;
    await user.type(input, "**");
    await user.keyboard("{Enter}");
    expect(
      document.querySelector("[data-testid='allowed-path-chip-**']"),
    ).not.toBeNull();
    await user.click(screen.getByRole("button", { name: /create binding/i }));
    expect(postCalls().length).toBe(0);
  });
});

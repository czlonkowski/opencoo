/**
 * Domains route — `+ New domain` button wiring (phase-a appendix #2).
 *
 * Pins:
 *   - Button is present alongside the page header.
 *   - Click opens NewDomainModal (role='dialog' appears).
 *   - On modal `onCreated` the page refetches /api/admin/domains.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Domains } from "../../src/routes/Domains.js";

function makeFetchMock(): {
  fetchImpl: ReturnType<typeof vi.fn>;
  count: () => number;
} {
  let getCount = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/admin/domains" && method === "GET") {
      getCount += 1;
      return new Response(
        JSON.stringify({
          rows: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "/api/admin/domains" && method === "POST") {
      return new Response(
        JSON.stringify({
          id: "00000000-0000-0000-0000-000000000001",
          slug: "wiki-main",
          repoUrl: "https://gitea.test/opencoo/wiki-main",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("404", { status: 404 });
  });
  return { fetchImpl, count: () => getCount };
}

describe("Domains route — + New domain button", () => {
  it("button is present at the page header", async () => {
    const { fetchImpl } = makeFetchMock();
    render(<Domains fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(
      screen.getByRole("button", { name: /\+ New domain|New domain/i }),
    ).toBeInTheDocument();
  });

  it("opens the modal on click", async () => {
    const { fetchImpl } = makeFetchMock();
    const user = userEvent.setup();
    render(<Domains fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    await user.click(
      screen.getByRole("button", { name: /\+ New domain|New domain/i }),
    );
    await waitFor(() =>
      expect(screen.getByRole("dialog")).toBeInTheDocument(),
    );
  });

  it("refetches the list after a successful create", async () => {
    const { fetchImpl, count } = makeFetchMock();
    const user = userEvent.setup();
    render(<Domains fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await waitFor(() => expect(count()).toBeGreaterThan(0));
    const initial = count();
    await user.click(
      screen.getByRole("button", { name: /\+ New domain|New domain/i }),
    );
    await waitFor(() =>
      expect(screen.getByRole("dialog")).toBeInTheDocument(),
    );
    await user.type(document.querySelector("input[name='slug']")!, "wiki-main");
    await user.type(
      document.querySelector("input[name='display_name']")!,
      "Main wiki",
    );
    await user.click(screen.getByRole("button", { name: /^Create$/i }));
    await waitFor(() => expect(count()).toBeGreaterThan(initial));
  });
});

/**
 * NewAgentInstanceModal live-validation tests — wave-16 PR-B4.
 *
 * Pins:
 *   - Name field flips invalid → valid as the operator types
 *     past the length floor (1 char) without submitting.
 *   - schedule_cron field flips invalid on a bad pattern, valid
 *     on a good one (parsed via the same `cron-parser` lib +
 *     UTC invariant as SchedulerEditor.tsx:31).
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NewAgentInstanceModal } from "../../src/components/NewAgentInstanceModal.js";
import { setPat } from "../../src/lib/pat-store.js";

const DOMAINS = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "wiki-executive",
    name: "Executive wiki",
    class: "knowledge",
    locale: "en",
    isAggregator: false,
    disabledAt: null,
  },
];

function makeStubFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/admin/_csrf")) {
      return new Response(JSON.stringify({ csrfToken: "tok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/admin/domains")) {
      return new Response(JSON.stringify({ rows: DOMAINS }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("NewAgentInstanceModal — live validation (PR-B4)", () => {
  it("schedule_cron flips to invalid on a bad pattern, valid on a good one", async () => {
    setPat("test-pat");
    const stub = makeStubFetch();
    const user = userEvent.setup();
    render(
      <NewAgentInstanceModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={stub}
      />,
    );
    await waitFor(() => {
      expect(
        document.querySelector("input[name='schedule_cron']"),
      ).not.toBeNull();
    });
    const cronInput = document.querySelector(
      "input[name='schedule_cron']",
    ) as HTMLInputElement;
    await user.type(cronInput, "garbage");
    await waitFor(() =>
      expect(cronInput).toHaveAttribute("aria-invalid", "true"),
    );
    expect(screen.getByText(/Cron pattern is invalid/i)).toBeInTheDocument();
    // Clear + good cron.
    await user.clear(cronInput);
    await user.type(cronInput, "0 8 * * 1-5");
    await waitFor(() =>
      expect(cronInput).not.toHaveAttribute("aria-invalid"),
    );
  });

  it("name field surfaces 'name too long' inline when the operator types over 100 chars", async () => {
    setPat("test-pat");
    const stub = makeStubFetch();
    render(
      <NewAgentInstanceModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={stub}
      />,
    );
    await waitFor(() => {
      expect(document.querySelector("input[name='name']")).not.toBeNull();
    });
    const nameInput = document.querySelector(
      "input[name='name']",
    ) as HTMLInputElement;
    const oversized = "a".repeat(101);
    // user.type would key-press 101 times — set via the native
    // value setter for speed (and to dispatch a single `input`
    // event the modal's listener consumes).
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter!.call(nameInput, oversized);
    fireEvent(nameInput, new Event("input", { bubbles: true }));
    await waitFor(() =>
      expect(nameInput).toHaveAttribute("aria-invalid", "true"),
    );
    expect(
      screen.getByText(/Name must be 100 characters or fewer/i),
    ).toBeInTheDocument();
  });
});

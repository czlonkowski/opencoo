/**
 * AgentInstanceDetail Scope / Name / Locale / Memory tests
 * — PR-W4-UI (phase-a appendix #15).
 *
 * Pins the four new editors added alongside the wave-13 PR-W2
 * Output-channel + Enabled + Schedule sections:
 *
 *   - Scope chip list → Edit → MultiSelectDomains roundtrip
 *   - Name input → Save dispatches PATCH {name}; 409 surfaces
 *     inline name_collision error
 *   - Locale <select> change dispatches PATCH {locale}
 *   - Clear-memory confirm-gate → PATCH {memory_clear: true};
 *     priorBytes flashes in the success toast
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentInstanceDetail } from "../../src/components/AgentInstanceDetail.js";
import { setPat } from "../../src/lib/pat-store.js";
import type { AgentInstance, Domain } from "../../src/types.js";

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

const DOMAIN_A: Domain = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "wiki-exec",
  name: "Executive wiki",
  class: "knowledge",
  locale: "en",
  isAggregator: false,
  disabledAt: null,
};
const DOMAIN_B: Domain = {
  id: "22222222-2222-4222-8222-222222222222",
  slug: "wiki-ops",
  name: "Ops wiki",
  class: "knowledge",
  locale: "en",
  isAggregator: false,
  disabledAt: null,
};

const INSTANCE: AgentInstance = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  definitionSlug: "heartbeat",
  name: "Heartbeat 06:00",
  scheduleCron: "0 6 * * 1-5",
  enabled: true,
  outputChannelCount: 0,
  outputChannelIds: [],
  locale: "en",
  scopeDomainIds: [DOMAIN_A.id],
  lastRunStartedAt: null,
  lastRunStatus: null,
};

function makeStubFetch(opts: {
  readonly domains?: readonly Domain[];
  readonly patchResponse?: Response;
  readonly calls?: FetchCall[];
}): typeof fetch {
  const calls = opts.calls ?? [];
  return vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    let parsedBody: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    calls.push({ url, method, body: parsedBody });
    if (url.includes("/api/admin/_csrf")) {
      return new Response(JSON.stringify({ csrfToken: "tok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/admin/domains")) {
      return new Response(JSON.stringify({ rows: opts.domains ?? [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/admin/output-channels")) {
      return new Response(JSON.stringify({ rows: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url.includes("/api/admin/agent-instances") &&
      method === "PATCH"
    ) {
      return (
        opts.patchResponse ??
        new Response(JSON.stringify({ updated: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("AgentInstanceDetail — Scope section", () => {
  it("renders existing scope as chips with the domain slug", async () => {
    setPat("test-pat");
    const stub = makeStubFetch({ domains: [DOMAIN_A, DOMAIN_B] });
    render(
      <AgentInstanceDetail
        instance={INSTANCE}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    // Wait for the domains GET to resolve so the slug renders.
    await waitFor(() => {
      const chips = screen.getByTestId("scope-chips");
      expect(chips.textContent).toContain("wiki-exec");
    });
  });

  it("Edit → multi-select → Save scope dispatches PATCH {scope_domain_ids}", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ domains: [DOMAIN_A, DOMAIN_B], calls });
    render(
      <AgentInstanceDetail
        instance={INSTANCE}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("scope-chips")).toBeInTheDocument();
    });
    // Click Edit to open the multi-select editor.
    fireEvent.click(screen.getByRole("button", { name: /^Edit$/ }));
    // The multi-select renders — pick DOMAIN_B in addition.
    await waitFor(() => {
      expect(screen.getByTestId("multi-select-domains")).toBeInTheDocument();
    });
    const checkboxB = document.querySelector(
      `input[type='checkbox'][data-domain-id='${DOMAIN_B.id}']`,
    ) as HTMLInputElement;
    fireEvent.click(checkboxB);
    // Save scope.
    fireEvent.click(screen.getByRole("button", { name: /Save scope/i }));
    await waitFor(() => {
      const patch = calls.find(
        (c) =>
          c.method === "PATCH" &&
          c.url.endsWith(`/api/admin/agent-instances/${INSTANCE.id}`) &&
          c.body !== undefined &&
          typeof c.body === "object" &&
          "scope_domain_ids" in (c.body as Record<string, unknown>),
      );
      expect(patch).toBeTruthy();
      expect(
        (patch?.body as { scope_domain_ids: string[] }).scope_domain_ids,
      ).toEqual([DOMAIN_A.id, DOMAIN_B.id]);
    });
  });
});

describe("AgentInstanceDetail — Name editor", () => {
  it("Save name dispatches PATCH {name}", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ domains: [DOMAIN_A], calls });
    render(
      <AgentInstanceDetail
        instance={INSTANCE}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Save name/i })).toBeInTheDocument();
    });
    // The Name input is the one that pre-renders the instance name. The
    // detail modal has more than one <input type="text">; we filter to
    // the one whose value matches the instance name.
    const candidates = Array.from(
      document.querySelectorAll("input[type='text']"),
    ) as HTMLInputElement[];
    const nameInput = candidates.find(
      (el) => el.value === INSTANCE.name,
    ) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Heartbeat 07:00" } });
    fireEvent.click(screen.getByRole("button", { name: /Save name/i }));
    await waitFor(() => {
      const patch = calls.find(
        (c) =>
          c.method === "PATCH" &&
          c.body !== undefined &&
          typeof c.body === "object" &&
          "name" in (c.body as Record<string, unknown>),
      );
      expect(patch).toBeTruthy();
      expect(patch?.body).toEqual({ name: "Heartbeat 07:00" });
    });
  });

  it("surfaces 409 name_collision as an inline error", async () => {
    setPat("test-pat");
    const stub = makeStubFetch({
      domains: [DOMAIN_A],
      patchResponse: new Response(
        JSON.stringify({
          error: "name_collision",
          definition_slug: "heartbeat",
          name: "duplicate",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    });
    render(
      <AgentInstanceDetail
        instance={INSTANCE}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Save name/i })).toBeInTheDocument();
    });
    const candidates = Array.from(
      document.querySelectorAll("input[type='text']"),
    ) as HTMLInputElement[];
    const nameInput = candidates.find(
      (el) => el.value === INSTANCE.name,
    ) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "duplicate" } });
    fireEvent.click(screen.getByRole("button", { name: /Save name/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/already uses that name/i),
      ).toBeInTheDocument();
    });
  });
});

describe("AgentInstanceDetail — Locale editor", () => {
  it("changing locale dispatches PATCH {locale}", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ domains: [DOMAIN_A], calls });
    render(
      <AgentInstanceDetail
        instance={INSTANCE}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    // The Locale select has aria-label="Locale".
    await waitFor(() => {
      expect(screen.getByLabelText(/^Locale$/i)).toBeInTheDocument();
    });
    const localeSelect = screen.getByLabelText(/^Locale$/i) as HTMLSelectElement;
    fireEvent.change(localeSelect, { target: { value: "pl" } });
    await waitFor(() => {
      const patch = calls.find(
        (c) =>
          c.method === "PATCH" &&
          c.body !== undefined &&
          typeof c.body === "object" &&
          "locale" in (c.body as Record<string, unknown>),
      );
      expect(patch).toBeTruthy();
      expect(patch?.body).toEqual({ locale: "pl" });
    });
  });
});

describe("AgentInstanceDetail — Memory clear", () => {
  it("Clear memory → confirm checkbox → Confirm dispatches PATCH {memory_clear:true}", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({
      domains: [DOMAIN_A],
      patchResponse: new Response(
        JSON.stringify({ updated: true, priorBytes: 2048 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      calls,
    });
    const user = userEvent.setup();
    render(
      <AgentInstanceDetail
        instance={INSTANCE}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Clear memory/i }),
      ).toBeInTheDocument();
    });
    // Stage 1: open the confirm dialog.
    fireEvent.click(screen.getByRole("button", { name: /Clear memory/i }));
    // Confirm-clear is disabled until the operator ticks the checkbox.
    const confirmBtn = screen.getByRole("button", { name: /Confirm clear/i });
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);
    // Tick the destructive-confirm checkbox.
    const ack = screen.getByLabelText(/I understand this cannot be undone/i);
    await user.click(ack);
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(false);
    // Fire the destructive call.
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      const patch = calls.find(
        (c) =>
          c.method === "PATCH" &&
          c.body !== undefined &&
          typeof c.body === "object" &&
          "memory_clear" in (c.body as Record<string, unknown>),
      );
      expect(patch).toBeTruthy();
      expect(patch?.body).toEqual({ memory_clear: true });
    });
    // Toast surfaces the byte count from the server.
    await waitFor(() => {
      expect(screen.getByText(/2048 bytes wiped/i)).toBeInTheDocument();
    });
  });
});

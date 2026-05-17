/**
 * NewAgentInstanceModal tests — PR-W4-UI (phase-a appendix #15).
 *
 * Pins the modal contract for `+ New agent instance`:
 *   - Renders as a dialog with the expected fields
 *   - Validates name + scope client-side before POSTing
 *   - Submits the right body shape on valid input
 *   - Maps 409 name_collision to an inline error
 *   - Maps 422 unknown_scope_domain_ids to an inline error
 *   - schedule_cron is omitted from the body when blank
 *   - Multi-select renders fetched domains + lets the operator
 *     pick / unpick
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NewAgentInstanceModal } from "../../src/components/NewAgentInstanceModal.js";
import { setPat } from "../../src/lib/pat-store.js";
import type { Domain } from "../../src/types.js";

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

const SAMPLE_DOMAIN_A: Domain = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "wiki-executive",
  name: "Executive wiki",
  class: "knowledge",
  locale: "en",
  isAggregator: false,
  disabledAt: null,
};

const SAMPLE_DOMAIN_B: Domain = {
  id: "22222222-2222-4222-8222-222222222222",
  slug: "wiki-ops",
  name: "Ops wiki",
  class: "knowledge",
  locale: "en",
  isAggregator: false,
  disabledAt: null,
};

const SAMPLE_DOMAIN_DISABLED: Domain = {
  id: "33333333-3333-4333-8333-333333333333",
  slug: "wiki-retired",
  name: "Retired wiki",
  class: "knowledge",
  locale: "en",
  isAggregator: false,
  disabledAt: "2026-01-01T00:00:00Z",
};

function makeStubFetch(opts: {
  readonly domains?: readonly Domain[];
  readonly postResponse?: Response;
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
    if (
      url.includes("/api/admin/agent-instances") &&
      method === "POST"
    ) {
      return (
        opts.postResponse ??
        new Response(
          JSON.stringify({
            id: "aaaaaaaa-0000-4000-8000-000000000001",
            definitionSlug: "heartbeat",
            name: "test instance",
            scopeDomainIds: [SAMPLE_DOMAIN_A.id],
            outputChannelIds: [],
            scheduleCron: null,
            locale: "en",
            enabled: true,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        )
      );
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("NewAgentInstanceModal", () => {
  it("renders as a dialog with the W4 fields", async () => {
    setPat("test-pat");
    const stub = makeStubFetch({ domains: [SAMPLE_DOMAIN_A] });
    render(
      <NewAgentInstanceModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={stub}
      />,
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    // The fields the operator must see — pin via element rather than text
    // alone since some labels (e.g. "agent definition") repeat in helper
    // copy.
    await waitFor(() => {
      expect(
        document.querySelector("select[name='definition_slug']"),
      ).toBeInTheDocument();
    });
    expect(document.querySelector("input[name='name']")).toBeInTheDocument();
    expect(
      document.querySelector("select[name='locale']"),
    ).toBeInTheDocument();
    expect(
      document.querySelector("input[name='schedule_cron']"),
    ).toBeInTheDocument();
    expect(screen.getByText(/scope domains/i)).toBeInTheDocument();
    expect(screen.getByText(/enabled on create/i)).toBeInTheDocument();
  });

  it("client-validates: name required + at least one scope domain", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ domains: [SAMPLE_DOMAIN_A], calls });
    const user = userEvent.setup();
    render(
      <NewAgentInstanceModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={stub}
      />,
    );
    // Wait for domains GET to settle so the picker is rendered.
    await waitFor(() => {
      expect(screen.getByText(/Executive wiki/)).toBeInTheDocument();
    });
    // Submit without filling name or picking a domain.
    await user.click(screen.getByRole("button", { name: /create instance/i }));
    expect(screen.getByText(/Name is required/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Select at least one domain/i),
    ).toBeInTheDocument();
    // No POST should have fired.
    expect(
      calls.find(
        (c) =>
          c.method === "POST" &&
          c.url.endsWith("/api/admin/agent-instances"),
      ),
    ).toBeUndefined();
  });

  it("submits the right body shape on valid input", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({
      domains: [SAMPLE_DOMAIN_A, SAMPLE_DOMAIN_B],
      calls,
    });
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(
      <NewAgentInstanceModal
        onCreated={onCreated}
        onClose={() => undefined}
        fetchImpl={stub}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Executive wiki/)).toBeInTheDocument();
    });
    // Type a name.
    const nameInput = document.querySelector(
      "input[name='name']",
    ) as HTMLInputElement;
    await user.type(nameInput, "Heartbeat 08:00");
    // Pick the first domain checkbox.
    const firstDomainCheckbox = document.querySelector(
      `input[type='checkbox'][data-domain-id='${SAMPLE_DOMAIN_A.id}']`,
    ) as HTMLInputElement;
    fireEvent.click(firstDomainCheckbox);
    // Submit.
    await user.click(screen.getByRole("button", { name: /create instance/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const post = calls.find(
      (c) =>
        c.method === "POST" && c.url.endsWith("/api/admin/agent-instances"),
    );
    expect(post).toBeTruthy();
    expect(post?.body).toMatchObject({
      definition_slug: "heartbeat",
      name: "Heartbeat 08:00",
      scope_domain_ids: [SAMPLE_DOMAIN_A.id],
      locale: "en",
      enabled: true,
    });
    // schedule_cron is absent (the operator did not type one).
    expect(
      (post?.body as Record<string, unknown> | undefined)?.["schedule_cron"],
    ).toBeUndefined();
  });

  it("inlines 'name_collision' from a 409 on the name field", async () => {
    setPat("test-pat");
    const stub = makeStubFetch({
      domains: [SAMPLE_DOMAIN_A],
      postResponse: new Response(
        JSON.stringify({
          error: "name_collision",
          definition_slug: "heartbeat",
          name: "Heartbeat 08:00",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    });
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(
      <NewAgentInstanceModal
        onCreated={onCreated}
        onClose={() => undefined}
        fetchImpl={stub}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Executive wiki/)).toBeInTheDocument();
    });
    const nameInput = document.querySelector(
      "input[name='name']",
    ) as HTMLInputElement;
    await user.type(nameInput, "Heartbeat 08:00");
    const firstDomainCheckbox = document.querySelector(
      `input[type='checkbox'][data-domain-id='${SAMPLE_DOMAIN_A.id}']`,
    ) as HTMLInputElement;
    fireEvent.click(firstDomainCheckbox);
    await user.click(screen.getByRole("button", { name: /create instance/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/already uses that name/i),
      ).toBeInTheDocument();
    });
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("inlines 'unknown_scope_domain_ids' from a 422 on the scope field", async () => {
    setPat("test-pat");
    const stub = makeStubFetch({
      domains: [SAMPLE_DOMAIN_A],
      postResponse: new Response(
        JSON.stringify({
          error: "unknown_scope_domain_ids",
          missing: [SAMPLE_DOMAIN_A.id],
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      ),
    });
    const user = userEvent.setup();
    render(
      <NewAgentInstanceModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={stub}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Executive wiki/)).toBeInTheDocument();
    });
    await user.type(
      document.querySelector("input[name='name']")!,
      "Heartbeat 08:00",
    );
    fireEvent.click(
      document.querySelector(
        `input[type='checkbox'][data-domain-id='${SAMPLE_DOMAIN_A.id}']`,
      )!,
    );
    await user.click(screen.getByRole("button", { name: /create instance/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/no longer exist/i),
      ).toBeInTheDocument();
    });
  });

  it("filters out disabled domains from the scope picker", async () => {
    setPat("test-pat");
    const stub = makeStubFetch({
      domains: [SAMPLE_DOMAIN_A, SAMPLE_DOMAIN_DISABLED],
    });
    render(
      <NewAgentInstanceModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={stub}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Executive wiki/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Retired wiki/)).not.toBeInTheDocument();
  });
});

/**
 * AgentInstancePromptsSection — PR-W7b (phase-a appendix #15)
 * unit tests.
 *
 * Pinned scenarios:
 *   1. heartbeat instance renders both `heartbeat` +
 *      `worldview-domain` rows, baseline-only stack.
 *   2. instance override present → resolution stack surfaces
 *      Instance + Baseline lines; Clear button appears.
 *   3. domain override present → resolution stack surfaces
 *      Domain (with slug) + Baseline lines.
 *   4. instance + domain both present → all three stack lines
 *      render (Instance, Domain, Baseline).
 *   5. Edit button opens nested editor modal scoped to
 *      agent-instances; preview/apply chain POSTs to
 *      `/api/admin/agent-instances/:id/prompts/.../preview` then
 *      `/apply` with baselineVersion echoed.
 *   6. Clear button → DELETE roundtrips to
 *      `/api/admin/agent-instances/:id/prompts/.../`.
 *   7. `locale = "pl"` → only pl rows render; `locale = "auto"`
 *      → both en and pl rows.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentInstancePromptsSection } from "../../src/components/AgentInstancePromptsSection.js";
import { setPat } from "../../src/lib/pat-store.js";
import type { AgentInstance } from "../../src/types.js";

const INSTANCE_ID = "11111111-2222-4333-8444-555555555555";
const DOMAIN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const BASE_INSTANCE: AgentInstance = {
  id: INSTANCE_ID,
  definitionSlug: "heartbeat",
  name: "Heartbeat 06:00",
  scheduleCron: "0 6 * * 1-5",
  enabled: true,
  outputChannelCount: 0,
  outputChannelIds: [],
  scopeDomainIds: [DOMAIN_ID],
  locale: "en",
  lastRunStartedAt: null,
  lastRunStatus: null,
};

interface PromptRow {
  readonly source: "baseline" | "override";
  readonly body: string;
  readonly version: string;
  readonly baselineVersion?: string;
  readonly isStale?: boolean;
}

interface FetchSpec {
  /** Instance-scope GET responses keyed by `${name}-${locale}`. */
  readonly instanceRows?: Readonly<Record<string, PromptRow>>;
  /** Domain-scope GET responses keyed by `${name}-${locale}`. */
  readonly domainRows?: Readonly<Record<string, PromptRow>>;
  /** Domains catalog rows. */
  readonly domains?: ReadonlyArray<{
    readonly id: string;
    readonly slug: string;
    readonly name: string;
  }>;
}

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function defaultRow(name: string, locale: string): PromptRow {
  return {
    source: "baseline",
    body: `baseline body of ${name} ${locale}`,
    version: "1.0.0",
  };
}

function makeFetch(spec: FetchSpec, calls: FetchCall[]): typeof fetch {
  return vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    let parsedBody: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    calls.push({ url, method, body: parsedBody });

    if (url === "/api/admin/_csrf") {
      return new Response(
        JSON.stringify({ csrfToken: "csrf-1", username: "alice" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url === "/api/admin/domains" && method === "GET") {
      return new Response(
        JSON.stringify({
          rows: spec.domains ?? [
            {
              id: DOMAIN_ID,
              slug: "wiki-exec",
              name: "Exec wiki",
              class: "knowledge",
              locale: "en",
              isAggregator: false,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const instanceSingle = url.match(
      /^\/api\/admin\/agent-instances\/[^/]+\/prompts\/([^/]+)\/([^/]+)$/,
    );
    if (instanceSingle !== null && method === "GET") {
      const key = `${instanceSingle[1]}-${instanceSingle[2]}`;
      const row = spec.instanceRows?.[key] ?? defaultRow(
        instanceSingle[1]!,
        instanceSingle[2]!,
      );
      return new Response(
        JSON.stringify({
          name: instanceSingle[1],
          locale: instanceSingle[2],
          scope: "agent-instances",
          ...row,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (instanceSingle !== null && method === "DELETE") {
      return new Response(JSON.stringify({ ok: true, deleted: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const domainSingle = url.match(
      /^\/api\/admin\/domains\/[^/]+\/prompts\/([^/]+)\/([^/]+)$/,
    );
    if (domainSingle !== null && method === "GET") {
      const key = `${domainSingle[1]}-${domainSingle[2]}`;
      const row = spec.domainRows?.[key] ?? defaultRow(
        domainSingle[1]!,
        domainSingle[2]!,
      );
      return new Response(
        JSON.stringify({
          name: domainSingle[1],
          locale: domainSingle[2],
          scope: "domains",
          ...row,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const previewMatch = url.match(
      /^\/api\/admin\/agent-instances\/[^/]+\/prompts\/[^/]+\/[^/]+\/preview$/,
    );
    if (previewMatch !== null && method === "POST") {
      return new Response(
        JSON.stringify({
          diff: [{ op: "add", line: "new", index: 0 }],
          token: "tok-1",
          expiresAt: Date.now() + 300_000,
          baselineVersion: "1.0.0",
          currentSource: "baseline",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const applyMatch = url.match(
      /^\/api\/admin\/agent-instances\/[^/]+\/prompts\/[^/]+\/[^/]+\/apply$/,
    );
    if (applyMatch !== null && method === "POST") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("AgentInstancePromptsSection (PR-W7b)", () => {
  it("renders one row per prompt the definition uses (heartbeat → heartbeat + worldview-domain)", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeFetch({}, calls);
    render(
      <AgentInstancePromptsSection
        instance={BASE_INSTANCE}
        fetchImpl={stub}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("prompt-row-heartbeat-en")).toBeTruthy();
    });
    expect(screen.getByTestId("prompt-row-worldview-domain-en")).toBeTruthy();
    // No instance override → no Clear button.
    expect(screen.queryByText(/Clear instance override/i)).toBeNull();
    // Baseline stack line is always present.
    expect(screen.getByTestId("stack-baseline-heartbeat-en").textContent).toMatch(
      /Shipped baseline/,
    );
  });

  it("surfaces an Instance override line + Clear button when one exists", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeFetch(
      {
        instanceRows: {
          "heartbeat-en": {
            source: "override",
            body: "instance body",
            version: "1.0.5",
            baselineVersion: "1.0.0",
            isStale: false,
          },
        },
      },
      calls,
    );
    render(
      <AgentInstancePromptsSection
        instance={BASE_INSTANCE}
        fetchImpl={stub}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("stack-instance-heartbeat-en")).toBeTruthy();
    });
    expect(
      screen.getByTestId("stack-instance-heartbeat-en").textContent,
    ).toMatch(/1\.0\.5/);
    // Clear button is row-scoped — there's at least one (this row).
    expect(
      screen.getAllByText(/Clear instance override/i).length,
    ).toBeGreaterThan(0);
  });

  it("surfaces a Domain override line with the resolved slug", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeFetch(
      {
        domainRows: {
          "heartbeat-en": {
            source: "override",
            body: "domain body",
            version: "2.0.0",
            baselineVersion: "1.0.0",
            isStale: false,
          },
        },
      },
      calls,
    );
    render(
      <AgentInstancePromptsSection
        instance={BASE_INSTANCE}
        fetchImpl={stub}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("stack-domain-heartbeat-en")).toBeTruthy();
    });
    const domainLine = screen.getByTestId("stack-domain-heartbeat-en");
    expect(domainLine.textContent).toMatch(/wiki-exec/);
    expect(domainLine.textContent).toMatch(/2\.0\.0/);
  });

  it("renders all three resolution lines when instance + domain overrides both exist", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeFetch(
      {
        instanceRows: {
          "heartbeat-en": {
            source: "override",
            body: "instance body",
            version: "3.1.4",
            baselineVersion: "1.0.0",
            isStale: false,
          },
        },
        domainRows: {
          "heartbeat-en": {
            source: "override",
            body: "domain body",
            version: "2.0.0",
            baselineVersion: "1.0.0",
            isStale: false,
          },
        },
      },
      calls,
    );
    render(
      <AgentInstancePromptsSection
        instance={BASE_INSTANCE}
        fetchImpl={stub}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("stack-instance-heartbeat-en")).toBeTruthy();
    });
    expect(screen.getByTestId("stack-domain-heartbeat-en")).toBeTruthy();
    expect(screen.getByTestId("stack-baseline-heartbeat-en")).toBeTruthy();
  });

  it("Edit opens the editor and Save → preview → Apply roundtrips through agent-instances API", async () => {
    setPat("test-pat");
    const user = userEvent.setup();
    const calls: FetchCall[] = [];
    const stub = makeFetch({}, calls);
    render(
      <AgentInstancePromptsSection
        instance={BASE_INSTANCE}
        fetchImpl={stub}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("prompt-row-heartbeat-en")).toBeTruthy();
    });
    // Click the first Edit button (heartbeat-en row).
    const editBtns = screen.getAllByText(/^Edit$/);
    await user.click(editBtns[0]!);
    await waitFor(() => {
      expect(screen.getByTestId("prompt-body-textarea")).toBeTruthy();
    });
    const textarea = screen.getByTestId(
      "prompt-body-textarea",
    ) as HTMLTextAreaElement;
    await user.clear(textarea);
    await user.type(textarea, "proposed body");
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => {
      const previewCall = calls.find(
        (c) =>
          c.method === "POST" &&
          c.url.includes(`/agent-instances/${INSTANCE_ID}/prompts/heartbeat/en/preview`),
      );
      expect(previewCall).toBeTruthy();
    });
    // Click Apply in the DiffPreviewDialog.
    await waitFor(() => {
      expect(screen.getByTestId("diff-list")).toBeTruthy();
    });
    await user.click(screen.getByRole("button", { name: /apply/i }));
    await waitFor(() => {
      const applyCall = calls.find(
        (c) =>
          c.method === "POST" &&
          c.url.includes(`/agent-instances/${INSTANCE_ID}/prompts/heartbeat/en/apply`),
      );
      expect(applyCall).toBeTruthy();
      expect(applyCall?.body).toMatchObject({
        proposedBody: "proposed body",
        token: "tok-1",
        confirmDiff: true,
        baselineVersion: "1.0.0",
      });
    });
  });

  it("Clear instance override roundtrips DELETE through agent-instances API", async () => {
    setPat("test-pat");
    const user = userEvent.setup();
    const calls: FetchCall[] = [];
    const stub = makeFetch(
      {
        instanceRows: {
          "heartbeat-en": {
            source: "override",
            body: "instance body",
            version: "1.0.5",
            baselineVersion: "1.0.0",
            isStale: false,
          },
        },
      },
      calls,
    );
    render(
      <AgentInstancePromptsSection
        instance={BASE_INSTANCE}
        fetchImpl={stub}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("stack-instance-heartbeat-en")).toBeTruthy();
    });
    const clearBtns = screen.getAllByText(/Clear instance override/i);
    fireEvent.click(clearBtns[0]!);
    // RevertOverrideModal — tick ack and confirm.
    const ack = await screen.findByTestId("revert-ack-checkbox");
    fireEvent.click(ack);
    const confirmBtn = (await screen.findByTestId(
      "revert-confirm-btn",
    )) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);
    await user.click(confirmBtn);
    await waitFor(() => {
      const del = calls.find(
        (c) =>
          c.method === "DELETE" &&
          c.url.includes(`/agent-instances/${INSTANCE_ID}/prompts/heartbeat/en`),
      );
      expect(del).toBeTruthy();
    });
  });

  it("locale='pl' renders only pl rows", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeFetch({}, calls);
    render(
      <AgentInstancePromptsSection
        instance={{ ...BASE_INSTANCE, locale: "pl" }}
        fetchImpl={stub}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("prompt-row-heartbeat-pl")).toBeTruthy();
    });
    expect(screen.queryByTestId("prompt-row-heartbeat-en")).toBeNull();
  });

  it("locale='auto' renders both en and pl rows", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeFetch({}, calls);
    render(
      <AgentInstancePromptsSection
        instance={{ ...BASE_INSTANCE, locale: "auto" }}
        fetchImpl={stub}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("prompt-row-heartbeat-en")).toBeTruthy();
    });
    expect(screen.getByTestId("prompt-row-heartbeat-pl")).toBeTruthy();
  });
});

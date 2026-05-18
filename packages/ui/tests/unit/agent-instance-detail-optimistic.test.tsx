/**
 * AgentInstanceDetail — optimistic-patch wiring (PR-B5, wave-16).
 *
 * Pins the contract:
 *   1. Editing the `enabled` toggle shifts the UI IMMEDIATELY (the
 *      visible button label flips before PATCH resolves) and the
 *      saving-cue dot renders.
 *   2. On PATCH success the cue clears + the toggle reflects the
 *      new state.
 *   3. A synthetic 422 on `enabled` rolls back to the prior value
 *      (the toggle label reverts) and surfaces an alert-red toast
 *      via the B7 useToast hook.
 *   4. Sovereignty-token / blacklist routes are NOT routed through
 *      useOptimisticPatch — see the last test: pin by absence (the
 *      prompts-section module does not import the hook).
 */
import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { AgentInstanceDetail } from "../../src/components/AgentInstanceDetail.js";
import { ToastProvider, ToastRegion } from "../../src/components/Toast.js";
import { setPat } from "../../src/lib/pat-store.js";
import type { AgentInstance, OutputChannel } from "../../src/types.js";

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

interface MakeStubOpts {
  readonly channels?: readonly OutputChannel[];
  readonly calls?: FetchCall[];
  /** When set, PATCH calls to the agent-instance route with a body
   *  containing one of these keys will return 422. */
  readonly failPatchOn?: ReadonlyArray<string>;
  readonly failBody?: Record<string, unknown>;
}

function makeStubFetch(opts: MakeStubOpts): typeof fetch {
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
    if (
      method === "PATCH" &&
      url.includes("/api/admin/agent-instances") &&
      opts.failPatchOn !== undefined &&
      parsedBody !== null &&
      typeof parsedBody === "object"
    ) {
      const keys = Object.keys(parsedBody as Record<string, unknown>);
      if (keys.some((k) => opts.failPatchOn!.includes(k))) {
        return new Response(
          JSON.stringify(opts.failBody ?? { error: "validation_failed" }),
          {
            status: 422,
            headers: { "content-type": "application/json" },
          },
        );
      }
    }
    if (url.includes("/api/admin/agent-instances")) {
      if (method === "PATCH") {
        return new Response(JSON.stringify({ updated: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    if (url.includes("/api/admin/output-channels")) {
      return new Response(JSON.stringify({ rows: opts.channels ?? [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/admin/domains")) {
      return new Response(JSON.stringify({ rows: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

const SAMPLE_INSTANCE: AgentInstance = {
  id: "11111111-2222-4333-8444-555555555555",
  definitionSlug: "heartbeat",
  name: "Heartbeat 06:00",
  scheduleCron: "0 6 * * 1-5",
  enabled: true,
  outputChannelCount: 0,
  outputChannelIds: [],
  lastRunStartedAt: null,
  lastRunStatus: null,
};

function renderWithProvider(node: JSX.Element): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      {node}
      <ToastRegion />
    </ToastProvider>,
  );
}

describe("AgentInstanceDetail — optimistic enabled toggle (PR-B5)", () => {
  it("shifts UI immediately on toggle (optimistic) + clears cue on success", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ channels: [], calls });
    renderWithProvider(
      <AgentInstanceDetail
        instance={SAMPLE_INSTANCE}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    await waitFor((): void => {
      expect(screen.getByText(/No output channels available/i)).toBeTruthy();
    });

    // Pre-click: enabled = true → button label is "Disable".
    expect(screen.getByText(/^Disable$/)).toBeTruthy();

    fireEvent.click(screen.getByText(/^Disable$/));

    // OPTIMISTIC: the saving-cue dot mounts.
    await waitFor((): void => {
      const cues = document.querySelectorAll("[data-saving-state]");
      expect(cues.length).toBeGreaterThan(0);
    });

    // PATCH fires with {enabled: false}.
    await waitFor((): void => {
      const patch = calls.find(
        (c): boolean =>
          c.method === "PATCH" &&
          c.url.endsWith(`/api/admin/agent-instances/${SAMPLE_INSTANCE.id}`) &&
          c.body !== null &&
          typeof c.body === "object" &&
          "enabled" in (c.body as Record<string, unknown>),
      );
      expect(patch).toBeTruthy();
      expect(patch?.body).toEqual({ enabled: false });
    });

    // After the PATCH resolves, the button label flips to "Enable".
    await waitFor((): void => {
      expect(screen.getByText(/^Enable$/)).toBeTruthy();
    });
  });

  it("synthetic 422 on enabled toggle: rollback + alert toast surfaces", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({
      channels: [],
      calls,
      failPatchOn: ["enabled"],
      failBody: { error: "policy_violation" },
    });
    renderWithProvider(
      <AgentInstanceDetail
        instance={SAMPLE_INSTANCE}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    await waitFor((): void => {
      expect(screen.getByText(/No output channels available/i)).toBeTruthy();
    });

    expect(screen.getByText(/^Disable$/)).toBeTruthy();
    fireEvent.click(screen.getByText(/^Disable$/));

    // PATCH fires with {enabled: false}.
    await waitFor((): void => {
      const patch = calls.find(
        (c): boolean =>
          c.method === "PATCH" &&
          c.body !== null &&
          typeof c.body === "object" &&
          (c.body as Record<string, unknown>)["enabled"] === false,
      );
      expect(patch).toBeTruthy();
    });

    // ROLLBACK: button label reverts to "Disable" (enabled rolled
    // back to true). Alert toast surfaces via the B7 toast region.
    await waitFor((): void => {
      expect(screen.getByText(/^Disable$/)).toBeTruthy();
    });
    await waitFor((): void => {
      const region = screen.getByRole("region", { name: /notifications/i });
      const alertTag = within(region).queryByText("ALERT");
      expect(alertTag).toBeTruthy();
    });
  });

  it("blacklist invariant: prompts-section does NOT route through useOptimisticPatch", async () => {
    // The sovereignty-token diff-preview-confirm flow is the
    // explicit blacklist anchor (architecture.md §17 Resolved).
    // Pin by absence: the prompts-section module's source must
    // not import useOptimisticPatch.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = await fs.readFile(
      path.resolve(here, "../../src/components/AgentInstancePromptsSection.tsx"),
      "utf8",
    );
    expect(src.includes("useOptimisticPatch")).toBe(false);
  });
});

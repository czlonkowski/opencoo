/**
 * SourceBindingDetail edit-mode tests — PR-R2, phase-a appendix #10.
 *
 * R2 widens the Q10 detail modal with an Edit toggle that flips
 * between view and edit modes. Edit mode renders TWO sections:
 *   - Operational settings (`bindingConfigSchema` form)
 *   - Rotate credentials   (`credentialSchema` form, all fields
 *                           empty, banner advising rotation is
 *                           atomic)
 *
 * On Save, the UI posts:
 *   - ONE PATCH `{config: {...}}` if only config changed,
 *   - ONE PATCH `{credentials: {...}}` if only creds changed,
 *   - TWO sequential PATCHes (config first, then credentials) if
 *     both changed — the discriminated body rejects mixed
 *     intents (one verb per audit row).
 *
 * Banner uses --ink-3 (informational), NOT --advisory.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SourceBindingDetail } from "../../src/components/SourceBindingDetail.js";
import type { SourceBinding } from "../../src/types.js";

const BINDING_ID = "11111111-2222-3333-4444-555555555555";

function makeBinding(overrides: Partial<SourceBinding> = {}): SourceBinding {
  return {
    id: BINDING_ID,
    domainSlug: "wiki-test",
    adapterSlug: "asana",
    reviewMode: "auto",
    enabled: true,
    notes: null,
    name: "asana → wiki-test",
    status: "healthy",
    lastEventAt: new Date(Date.now() - 60_000).toISOString(),
    lastError: null,
    pendingEventsCount: 0,
    sigFailCount24h: 0,
    ...overrides,
  };
}

/** Asana adapter descriptor as the GET /api/admin/adapters route
 *  returns it. The component fetches this on entering edit mode so
 *  it knows which fields to render. */
const ASANA_DESCRIPTOR = {
  slug: "asana",
  mode: "webhook" as const,
  credentialSchema: {
    type: "object",
    properties: {
      auth: {
        type: "object",
        properties: {
          personal_access_token: { type: "string", secret: true },
          workspace_gid: { type: "string" },
        },
        required: ["personal_access_token", "workspace_gid"],
      },
      webhook_secret: {
        type: "object",
        properties: {
          x_hook_secret: { type: "string", secret: true },
        },
        required: ["x_hook_secret"],
      },
    },
    required: ["auth", "webhook_secret"],
  },
  bindingConfigSchema: {
    type: "object",
    properties: {
      projectGid: {
        type: "string",
        description: "Asana project gid the adapter watches.",
        minLength: 1,
      },
      reviewMode: {
        type: "string",
        enum: ["auto", "review"],
        default: "auto",
      },
    },
    required: ["projectGid"],
  },
};

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

/** Build a fetch mock that:
 *   - serves GET /api/admin/adapters with the asana descriptor,
 *   - responds 200 to PATCH calls (configurable per-call).
 *
 *  Returns the mock + a `calls` snapshot helper so tests can assert
 *  on PATCH count + ordering. */
function makeFetchMock(
  patchResponses: Array<{ status: number; body: unknown }> = [],
): {
  fetchImpl: ReturnType<typeof vi.fn>;
  callsRef: { current: FetchCall[] };
} {
  const callsRef: { current: FetchCall[] } = { current: [] };
  let patchIdx = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : null;
    callsRef.current.push({ url, method, body });
    if (url === "/api/admin/adapters" && method === "GET") {
      return new Response(JSON.stringify({ adapters: [ASANA_DESCRIPTOR] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url === `/api/admin/source-bindings/${BINDING_ID}` &&
      method === "PATCH"
    ) {
      const r = patchResponses[patchIdx] ?? {
        status: 200,
        body: { id: BINDING_ID },
      };
      patchIdx += 1;
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl, callsRef };
}

describe("SourceBindingDetail edit mode (PR-R2)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("Edit toggle flips view → edit mode and renders config + credentials sections", async () => {
    const user = userEvent.setup();
    const { fetchImpl } = makeFetchMock();
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );

    // The Edit button is part of the always-visible row drill-down.
    await user.click(screen.getByRole("button", { name: /^edit$/i }));

    // Both section headings render (config + credentials).
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /^operational settings$/i }),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole("heading", { name: /^rotate credentials$/i }),
    ).toBeInTheDocument();

    // Save / Cancel buttons present.
    expect(screen.getByRole("button", { name: /^save$/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^cancel$/i }),
    ).toBeInTheDocument();
  });

  it("renders the rotation banner with --ink-3 (informational), NOT --advisory", async () => {
    const user = userEvent.setup();
    const { fetchImpl } = makeFetchMock();
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    const banner = await screen.findByTestId("rotation-banner");
    // Inline style: color === var(--ink-3); never --advisory.
    expect(banner.getAttribute("style") ?? "").toMatch(/var\(--ink-3\)/);
    expect(banner.getAttribute("style") ?? "").not.toMatch(/--advisory/);
    expect(banner.getAttribute("style") ?? "").not.toMatch(/--alert/);
  });

  it("Save with config-only changes posts ONE PATCH with `{config}` body", async () => {
    const user = userEvent.setup();
    const { fetchImpl, callsRef } = makeFetchMock();
    const onChanged = vi.fn();
    // Seed binding.config so the form pre-populates with the
    // persisted state — the route does jsonb-replace, so the body
    // must carry the FULL config (operator edits + unchanged
    // pre-existing values).
    const binding = makeBinding({
      config: { projectGid: "OLD-GID", reviewMode: "auto" },
    });
    render(
      <SourceBindingDetail
        binding={binding}
        onClose={() => undefined}
        onChanged={onChanged}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^edit$/i }));

    // Edit projectGid only — reviewMode should be preserved.
    const projectGidInput = await screen.findByTestId("edit-config-projectGid");
    await user.clear(projectGidInput);
    await user.type(projectGidInput, "99999");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    // Wait for PATCH dispatch.
    await waitFor(() => {
      const patches = callsRef.current.filter((c) => c.method === "PATCH");
      expect(patches.length).toBe(1);
    });

    const patches = callsRef.current.filter((c) => c.method === "PATCH");
    // Full config carried — operator's edit + the preserved
    // reviewMode that came from the binding row.
    expect(patches[0]!.body).toEqual({
      config: { projectGid: "99999", reviewMode: "auto" },
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it("Save with credentials-only changes posts ONE PATCH with `{credentials}` body", async () => {
    const user = userEvent.setup();
    const { fetchImpl, callsRef } = makeFetchMock();
    const onChanged = vi.fn();
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={() => undefined}
        onChanged={onChanged}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^edit$/i }));

    // Fill credentials fields only.
    const patInput = await screen.findByTestId(
      "edit-cred-auth.personal_access_token",
    );
    const wsInput = screen.getByTestId("edit-cred-auth.workspace_gid");
    const hookInput = screen.getByTestId(
      "edit-cred-webhook_secret.x_hook_secret",
    );
    await user.type(patInput, "new-pat");
    await user.type(wsInput, "ws-1");
    await user.type(hookInput, "hook-secret-1");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      const patches = callsRef.current.filter((c) => c.method === "PATCH");
      expect(patches.length).toBe(1);
    });
    const patches = callsRef.current.filter((c) => c.method === "PATCH");
    expect(patches[0]!.body).toEqual({
      credentials: {
        auth: {
          personal_access_token: "new-pat",
          workspace_gid: "ws-1",
        },
        webhook_secret: { x_hook_secret: "hook-secret-1" },
      },
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it("Save with BOTH changed posts TWO sequential PATCHes (config first, then credentials)", async () => {
    const user = userEvent.setup();
    const { fetchImpl, callsRef } = makeFetchMock([
      { status: 200, body: { id: BINDING_ID } },
      {
        status: 200,
        body: {
          id: BINDING_ID,
          credentialsRotatedAt: new Date().toISOString(),
        },
      },
    ]);
    const onChanged = vi.fn();
    const binding = makeBinding({
      config: { projectGid: "OLD-GID", reviewMode: "auto" },
    });
    render(
      <SourceBindingDetail
        binding={binding}
        onClose={() => undefined}
        onChanged={onChanged}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^edit$/i }));

    // Edit config field.
    const projectGidInput = await screen.findByTestId("edit-config-projectGid");
    await user.clear(projectGidInput);
    await user.type(projectGidInput, "55555");

    // Fill credentials.
    await user.type(
      screen.getByTestId("edit-cred-auth.personal_access_token"),
      "new-pat-x",
    );
    await user.type(
      screen.getByTestId("edit-cred-auth.workspace_gid"),
      "ws-x",
    );
    await user.type(
      screen.getByTestId("edit-cred-webhook_secret.x_hook_secret"),
      "hook-x",
    );

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      const patches = callsRef.current.filter((c) => c.method === "PATCH");
      expect(patches.length).toBe(2);
    });
    const patches = callsRef.current.filter((c) => c.method === "PATCH");
    // Config goes first.
    expect(patches[0]!.body).toMatchObject({ config: { projectGid: "55555" } });
    expect(patches[1]!.body).toMatchObject({
      credentials: {
        auth: {
          personal_access_token: "new-pat-x",
          workspace_gid: "ws-x",
        },
        webhook_secret: { x_hook_secret: "hook-x" },
      },
    });
    // onChanged called at least twice (one per success).
    expect(onChanged.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("422 from config validation surfaces inline error mapped to the offending field", async () => {
    const user = userEvent.setup();
    // Server returns 422 with `missing: ["projectGid"]`.
    const { fetchImpl } = makeFetchMock([
      {
        status: 422,
        body: {
          error: "binding_config_schema_mismatch",
          missing: ["projectGid"],
        },
      },
    ]);
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    const projectGidInput = await screen.findByTestId("edit-config-projectGid");
    await user.clear(projectGidInput);
    await user.type(projectGidInput, "x");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    // Inline field error references projectGid.
    const fieldErr = await screen.findByTestId(
      "edit-config-projectGid-error",
    );
    expect(fieldErr.textContent).toMatch(/projectGid|required/i);
  });

  it("Cancel reverts to view mode without making any PATCH calls", async () => {
    const user = userEvent.setup();
    const { fetchImpl, callsRef } = makeFetchMock();
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    // Type into a field then cancel.
    const projectGidInput = await screen.findByTestId("edit-config-projectGid");
    await user.type(projectGidInput, "abc");

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));

    // Back in view mode — webhook URL is the load-bearing element of
    // the Q10 view; assert it's visible again.
    expect(
      screen.getByText(`${window.location.origin}/webhooks/${BINDING_ID}`),
    ).toBeInTheDocument();

    // No PATCH was issued. Adapter GET is allowed; it's not a state change.
    const patches = callsRef.current.filter((c) => c.method === "PATCH");
    expect(patches.length).toBe(0);
  });
});

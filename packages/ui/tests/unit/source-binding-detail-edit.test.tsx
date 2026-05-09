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

  it("Save with AUTH-only credential changes posts ONE PATCH with `{credentials: { auth }}` (no webhook_secret key)", async () => {
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

    // Fill ONLY the auth half — webhook_secret untouched.
    const patInput = await screen.findByTestId(
      "edit-cred-auth.personal_access_token",
    );
    const wsInput = screen.getByTestId("edit-cred-auth.workspace_gid");
    await user.type(patInput, "new-pat-only");
    await user.type(wsInput, "ws-only");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      const patches = callsRef.current.filter((c) => c.method === "PATCH");
      expect(patches.length).toBe(1);
    });
    const patches = callsRef.current.filter((c) => c.method === "PATCH");
    // Body must NOT include `webhook_secret` — partial rotation
    // sends only the half(ves) the operator actually edited.
    expect(patches[0]!.body).toEqual({
      credentials: {
        auth: {
          personal_access_token: "new-pat-only",
          workspace_gid: "ws-only",
        },
      },
    });
    const credsBody = (patches[0]!.body as { credentials: Record<string, unknown> })
      .credentials;
    expect(Object.keys(credsBody)).not.toContain("webhook_secret");
    expect(onChanged).toHaveBeenCalled();
  });

  it("Save with WEBHOOK_SECRET-only credential changes posts ONE PATCH with `{credentials: { webhook_secret }}` (no auth key)", async () => {
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

    const hookInput = await screen.findByTestId(
      "edit-cred-webhook_secret.x_hook_secret",
    );
    await user.type(hookInput, "hook-only");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      const patches = callsRef.current.filter((c) => c.method === "PATCH");
      expect(patches.length).toBe(1);
    });
    const patches = callsRef.current.filter((c) => c.method === "PATCH");
    expect(patches[0]!.body).toEqual({
      credentials: {
        webhook_secret: { x_hook_secret: "hook-only" },
      },
    });
    const credsBody = (patches[0]!.body as { credentials: Record<string, unknown> })
      .credentials;
    expect(Object.keys(credsBody)).not.toContain("auth");
    expect(onChanged).toHaveBeenCalled();
  });

  it("Save with BOTH credential halves posts ONE PATCH with both keys (NOT split into two requests)", async () => {
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

    // Fill BOTH halves.
    await user.type(
      await screen.findByTestId("edit-cred-auth.personal_access_token"),
      "new-pat-both",
    );
    await user.type(
      screen.getByTestId("edit-cred-auth.workspace_gid"),
      "ws-both",
    );
    await user.type(
      screen.getByTestId("edit-cred-webhook_secret.x_hook_secret"),
      "hook-both",
    );

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      const patches = callsRef.current.filter((c) => c.method === "PATCH");
      expect(patches.length).toBe(1);
    });
    const patches = callsRef.current.filter((c) => c.method === "PATCH");
    // Single PATCH carries both halves — the credentials sub-split
    // is partial-rotation, NOT the config+credentials split. The
    // server-side audit row records both rotated_credentials in one
    // verb when both halves arrive together.
    expect(patches[0]!.body).toEqual({
      credentials: {
        auth: {
          personal_access_token: "new-pat-both",
          workspace_gid: "ws-both",
        },
        webhook_secret: { x_hook_secret: "hook-both" },
      },
    });
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

  it("buildConfigBody emits an explicit [] for a required array field whose entries the operator deleted (no silent drop)", async () => {
    const user = userEvent.setup();
    const { callsRef } = makeFetchMock();
    const onChanged = vi.fn();
    // Use a binding whose persisted config seeds an array field.
    // The descriptor returned by the mocked /api/admin/adapters
    // declares `tags: type=array, items.type=string`, required.
    const arrayDescriptor = {
      slug: "asana",
      mode: "webhook" as const,
      credentialSchema: ASANA_DESCRIPTOR.credentialSchema,
      bindingConfigSchema: {
        type: "object",
        properties: {
          projectGid: { type: "string", minLength: 1 },
          tags: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["projectGid", "tags"],
      },
    };
    const fetchWithArray = vi.fn(
      async (input: RequestInfo, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        const body =
          init?.body !== undefined ? JSON.parse(String(init.body)) : null;
        callsRef.current.push({ url, method, body });
        if (url === "/api/admin/adapters" && method === "GET") {
          return new Response(
            JSON.stringify({ adapters: [arrayDescriptor] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (
          url === `/api/admin/source-bindings/${BINDING_ID}` &&
          method === "PATCH"
        ) {
          return new Response(JSON.stringify({ id: BINDING_ID }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    const binding = makeBinding({
      config: { projectGid: "OLD-GID", tags: ["alpha", "beta"] },
    });
    render(
      <SourceBindingDetail
        binding={binding}
        onClose={() => undefined}
        onChanged={onChanged}
        fetchImpl={fetchWithArray as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^edit$/i }));

    // Clear the array field — operator decided "this binding has no
    // tags". The body must carry `tags: []`, NOT silently drop it.
    const tagsInput = await screen.findByTestId("edit-config-tags");
    await user.clear(tagsInput);

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      const patches = callsRef.current.filter((c) => c.method === "PATCH");
      expect(patches.length).toBe(1);
    });
    const patches = callsRef.current.filter((c) => c.method === "PATCH");
    const configBody = (patches[0]!.body as { config: Record<string, unknown> })
      .config;
    expect(configBody).toHaveProperty("tags");
    expect(configBody["tags"]).toEqual([]);
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

  // ─── PR-R2 second Copilot fix-up — cancel hygiene + 422 stale-error race ──

  it("Cancel clears typed credential plaintext + resets config; re-Edit reads a clean state", async () => {
    // Issue 1 — onIdle must reset configValues + credentialValues so
    // typed plaintext doesn't sit in component state across Cancel
    // and re-entered Edit. Without the fix, hitting Edit again would
    // surface the cancelled credential string in the input.
    const user = userEvent.setup();
    const { fetchImpl } = makeFetchMock();
    const binding = makeBinding({
      config: { projectGid: "PERSISTED-GID", reviewMode: "auto" },
    });
    render(
      <SourceBindingDetail
        binding={binding}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^edit$/i }));

    // Type a new PAT (sensitive) and overwrite the persisted config
    // value, then Cancel.
    const projectGidInput = await screen.findByTestId("edit-config-projectGid");
    await user.clear(projectGidInput);
    await user.type(projectGidInput, "TYPED-AND-CANCELLED");
    const patInput = screen.getByTestId(
      "edit-cred-auth.personal_access_token",
    );
    await user.type(patInput, "secret-cancelled-pat");

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));

    // Re-enter edit mode WITHOUT closing the modal first — this is
    // the leak window the fix closes.
    await user.click(screen.getByRole("button", { name: /^edit$/i }));

    // Credential field MUST be empty (credentials are never re-seeded
    // for security; cancelled plaintext must not persist in state).
    const patAgain = await screen.findByTestId(
      "edit-cred-auth.personal_access_token",
    );
    expect((patAgain as HTMLInputElement).value).toBe("");

    // Config field MUST reset to the persisted seed (NOT the cancelled
    // typed value). Operator's cancelled edit is gone.
    const projectAgain = screen.getByTestId(
      "edit-config-projectGid",
    ) as HTMLInputElement;
    expect(projectAgain.value).toBe("PERSISTED-GID");
  });

  it("422 errors REPLACE the field-error map: stale errors don't carry over across attempts", async () => {
    // Issue 2 — the first Save fails with errors on BOTH projectGid
    // and workspaceGid. Operator corrects projectGid (typing clears
    // its error via `clearFieldError`) but does NOT touch
    // workspaceGid (its stale error stays in `fieldErrors`). Second
    // Save fails on a THIRD field (a credential field) only.
    //
    // With the buggy `{ ...fieldErrors, [newPath]: error }` merge,
    // workspaceGid's stale error would persist into the second
    // result. With the REPLACE fix, only the new error is shown.
    const user = userEvent.setup();
    const twoFieldDescriptor = {
      slug: "asana",
      mode: "webhook" as const,
      credentialSchema: ASANA_DESCRIPTOR.credentialSchema,
      bindingConfigSchema: {
        type: "object",
        properties: {
          projectGid: { type: "string", minLength: 1 },
          workspaceGid: { type: "string", minLength: 1 },
        },
        required: ["projectGid", "workspaceGid"],
      },
    };
    const callsRef: { current: FetchCall[] } = { current: [] };
    let patchIdx = 0;
    const responses = [
      // First Save: 422 on BOTH projectGid AND workspaceGid.
      {
        status: 422,
        body: {
          error: "binding_config_schema_mismatch",
          missing: ["projectGid", "workspaceGid"],
        },
      },
      // Second Save: 422 on a different field only.
      {
        status: 422,
        body: {
          error: "binding_config_schema_mismatch",
          missing: ["projectGid"],
        },
      },
    ];
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      const body =
        init?.body !== undefined ? JSON.parse(String(init.body)) : null;
      callsRef.current.push({ url, method, body });
      if (url === "/api/admin/adapters" && method === "GET") {
        return new Response(
          JSON.stringify({ adapters: [twoFieldDescriptor] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (
        url === `/api/admin/source-bindings/${BINDING_ID}` &&
        method === "PATCH"
      ) {
        const r = responses[patchIdx] ?? {
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

    const binding = makeBinding({
      config: { projectGid: "OLD", workspaceGid: "OLD-WS" },
    });
    render(
      <SourceBindingDetail
        binding={binding}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^edit$/i }));

    // First Save attempt — both fields will 422.
    const projectGidInput = await screen.findByTestId(
      "edit-config-projectGid",
    );
    await user.clear(projectGidInput);
    await user.type(projectGidInput, "bad-1");
    const workspaceGidInput = screen.getByTestId("edit-config-workspaceGid");
    await user.clear(workspaceGidInput);
    await user.type(workspaceGidInput, "bad-2");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    // Both errors land.
    await screen.findByTestId("edit-config-projectGid-error");
    expect(
      screen.getByTestId("edit-config-workspaceGid-error"),
    ).toBeInTheDocument();

    // Second Save WITHOUT touching either field — server returns 422
    // for projectGid only. workspaceGid's stale error must drop
    // because the second response no longer lists it.
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      // The second-attempt response only flags projectGid.
      expect(
        screen.getByTestId("edit-config-projectGid-error"),
      ).toBeInTheDocument();
    });
    // Workspace's stale error from the FIRST attempt must NOT persist
    // — REPLACE semantics drop it because the second response didn't
    // include it.
    expect(
      screen.queryByTestId("edit-config-workspaceGid-error"),
    ).not.toBeInTheDocument();
  });
});

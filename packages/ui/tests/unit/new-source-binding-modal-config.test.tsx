/**
 * NewSourceBindingModal — operational settings step (PR-Q9 of
 * phase-a appendix #9).
 *
 * Pre-Q9 the modal was a two-step flow: picker → credentials.
 * That left `sources_bindings.config` as the empty `{}` jsonb
 * the column DDL DEFAULTs to, which made every Asana binding
 * 500 at first webhook delivery (the adapter's Zod schema
 * requires `projectGid`).
 *
 * Q9 adds a third step that renders each adapter's
 * `bindingConfigSchema` so the operator fills in operational
 * settings BEFORE the binding is created. The submit body now
 * carries `config: { ... }` alongside `credentials: { ... }`.
 *
 * Pins:
 *   1. Polling adapter (drive) renders config-step inputs for
 *      `folderId` / `mimeTypes` / `contentKind`.
 *   2. Required config field with empty value triggers
 *      validation error and BLOCKS submit.
 *   3. Optional config field can be omitted; submit succeeds.
 *   4. Submit body shape includes nested `config` for asana.
 *   5. Hidden config field (asana.webhookSecretCredentialId)
 *      does NOT render an input.
 *   6. Config-step inputs do NOT render the `data-secret="true"`
 *      attribute — these are operational settings, not creds.
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
          service_account_json: { type: "string", secret: true, description: "JSON key" },
          root_folder_id: { type: "string", description: "Folder id" },
        },
        required: ["service_account_json", "root_folder_id"],
      },
      bindingConfigSchema: {
        type: "object",
        properties: {
          folderId: {
            type: "string",
            description: "Drive folder id the adapter scans recursively.",
            minLength: 1,
          },
          mimeTypes: {
            type: "array",
            description:
              "Mime-type whitelist. Defaults to {google-doc, pdf}.",
            items: { type: "string" },
            default: [
              "application/vnd.google-apps.document",
              "application/pdf",
            ],
          },
          contentKind: {
            type: "string",
            description: "Content kind for downstream routing.",
            enum: [
              "document",
              "n8n-workflow",
              "asana-project",
              "skill-bundle",
              "webhook-event",
            ],
            default: "document",
          },
        },
        required: ["folderId"],
      },
      defaultAllowedPaths: ["meetings/**", "transcripts/**", "docs/**"],
    },
    {
      slug: "asana",
      mode: "webhook" as const,
      credentialSchema: {
        type: "object",
        properties: {
          auth: {
            type: "object",
            properties: {
              personal_access_token: { type: "string", secret: true, description: "PAT" },
              workspace_gid: { type: "string", description: "Workspace gid" },
            },
            required: ["personal_access_token", "workspace_gid"],
          },
          webhook_secret: {
            type: "object",
            properties: {
              x_hook_secret: { type: "string", secret: true, description: "Hook secret" },
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
          workspaceGid: {
            type: "string",
            description: "Optional workspace gid for cross-checks.",
          },
          webhookSecretCredentialId: {
            type: "string",
            description: "Backfilled by the X-Hook-Secret handshake.",
            hidden: true,
          },
          reviewMode: {
            type: "string",
            description: "Operator review gating.",
            enum: ["auto", "review"],
            default: "auto",
          },
        },
        required: ["projectGid"],
      },
      defaultAllowedPaths: ["projects/**", "tasks/**"],
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
          (((c[1] as RequestInit | undefined)?.method ?? "GET").toUpperCase() ===
          "POST"),
      )
      .map((c) => [String(c[0]), c[1] as RequestInit]);
  return { fetchImpl, postCalls };
}

/** Common boot helper: open the modal, wait for adapter dropdown,
 *  optionally pick adapter, advance through both intermediate
 *  steps. */
async function bootAndAdvanceToConfig(
  user: ReturnType<typeof userEvent.setup>,
  adapterSlug: string | undefined,
  fillCredentials: () => Promise<void>,
): Promise<void> {
  await waitFor(() =>
    expect(
      document.querySelector("select[name='adapter_slug']"),
    ).not.toBeNull(),
  );
  if (adapterSlug !== undefined) {
    await user.selectOptions(
      document.querySelector("select[name='adapter_slug']")!,
      adapterSlug,
    );
  }
  await user.click(screen.getByRole("button", { name: /next/i }));
  await fillCredentials();
  // Credentials → config step.
  await user.click(screen.getByRole("button", { name: /next/i }));
}

/** PR-W1 (phase-a appendix #14): advance from the config step into
 *  the allowed_paths step. The config step's primary CTA is now
 *  "Next" (used to be "Create binding"); the allowed_paths step's
 *  primary CTA is "Create binding". After this call, the operator
 *  is on the allowed_paths step with the suggestions visible. */
async function advanceFromConfigToAllowedPaths(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  // The config step's submit button is now "Next" (the wizard's
  // primary CTA propagates through every step except the last).
  await user.click(screen.getByRole("button", { name: /^next$/i }));
  await waitFor(() =>
    expect(
      document.querySelector("[data-testid='allowed-paths-selected']"),
    ).not.toBeNull(),
  );
}

/** Pick the first suggestion chip on the allowed_paths step, then
 *  click "Create binding" to submit. */
async function pickFirstSuggestionAndSubmit(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  const suggestions = document.querySelectorAll(
    "[data-testid^='allowed-path-suggestion-']",
  );
  if (suggestions.length === 0) {
    throw new Error("expected at least one suggestion chip");
  }
  await user.click(suggestions[0]! as HTMLElement);
  await user.click(screen.getByRole("button", { name: /create binding/i }));
}

describe("NewSourceBindingModal — operational settings step (PR-Q9)", () => {
  it("renders binding-config inputs for a polling adapter (drive)", async () => {
    const { fetchImpl } = makeFetchMock();
    const user = userEvent.setup();
    render(
      <NewSourceBindingModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await bootAndAdvanceToConfig(user, "drive", async () => {
      await user.type(
        document.querySelector("input[name='service_account_json']")!,
        "json",
      );
      await user.type(
        document.querySelector("input[name='root_folder_id']")!,
        "1XYZ",
      );
    });
    // Required string field rendered.
    expect(document.querySelector("input[name='folderId']")).not.toBeNull();
    // contentKind enum surfaced; the form renders it as a select
    // for enums OR as a text input — minimum requirement is a
    // form control with the right name.
    const contentKindControl =
      document.querySelector("input[name='contentKind'], select[name='contentKind']");
    expect(contentKindControl).not.toBeNull();
  });

  it("blocks submit when a required config field is empty (drive → folderId)", async () => {
    const { fetchImpl, postCalls } = makeFetchMock();
    const user = userEvent.setup();
    render(
      <NewSourceBindingModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await bootAndAdvanceToConfig(user, "drive", async () => {
      await user.type(
        document.querySelector("input[name='service_account_json']")!,
        "json",
      );
      await user.type(
        document.querySelector("input[name='root_folder_id']")!,
        "1XYZ",
      );
    });
    // Click Next without filling folderId. PR-W1: the config-step
    // CTA is now "Next" — the required-field gate still blocks
    // advancement into the allowed_paths step, so no POST is sent.
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    // No POST went out — required-field validation kept us here.
    expect(postCalls().length).toBe(0);
    // And the wizard did NOT advance to the allowed_paths step:
    // the data-testid that only exists in the 4th step is absent.
    expect(
      document.querySelector("[data-testid='allowed-paths-selected']"),
    ).toBeNull();
  });

  it("submit body carries nested `config` for the asana wizard", async () => {
    const { fetchImpl, postCalls } = makeFetchMock();
    const user = userEvent.setup();
    render(
      <NewSourceBindingModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await bootAndAdvanceToConfig(user, "asana", async () => {
      await user.type(
        document.querySelector("input[name='auth.personal_access_token']")!,
        "asana-pat",
      );
      await user.type(
        document.querySelector("input[name='auth.workspace_gid']")!,
        "ws-1",
      );
      await user.type(
        document.querySelector("input[name='webhook_secret.x_hook_secret']")!,
        "hook-aaa",
      );
    });
    // Required projectGid + optional workspaceGid.
    await user.type(
      document.querySelector("input[name='projectGid']")!,
      "12345678",
    );
    await user.type(
      document.querySelector("input[name='workspaceGid']")!,
      "ws-1",
    );
    // PR-W1 (phase-a appendix #14): advance into the allowed_paths
    // step, click the first suggestion chip, then submit.
    await advanceFromConfigToAllowedPaths(user);
    await pickFirstSuggestionAndSubmit(user);

    await waitFor(() => expect(postCalls().length).toBe(1));
    const [, init] = postCalls()[0]!;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      adapter_slug: "asana",
      target_domain_slug: "wiki-main",
      credentials: {
        auth: { personal_access_token: "asana-pat", workspace_gid: "ws-1" },
        webhook_secret: { x_hook_secret: "hook-aaa" },
      },
      config: {
        projectGid: "12345678",
        workspaceGid: "ws-1",
      },
    });
    // PR-W1: allowed_paths must be present + non-empty.
    expect(Array.isArray(body["allowed_paths"])).toBe(true);
    expect((body["allowed_paths"] as readonly string[]).length).toBeGreaterThan(
      0,
    );
  });

  it("hidden config fields do NOT render an input (asana.webhookSecretCredentialId)", async () => {
    const { fetchImpl } = makeFetchMock();
    const user = userEvent.setup();
    render(
      <NewSourceBindingModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await bootAndAdvanceToConfig(user, "asana", async () => {
      await user.type(
        document.querySelector("input[name='auth.personal_access_token']")!,
        "p",
      );
      await user.type(
        document.querySelector("input[name='auth.workspace_gid']")!,
        "w",
      );
      await user.type(
        document.querySelector("input[name='webhook_secret.x_hook_secret']")!,
        "h",
      );
    });
    expect(
      document.querySelector("input[name='webhookSecretCredentialId']"),
    ).toBeNull();
  });

  it("config-step inputs do NOT carry data-secret='true' (these are operational settings)", async () => {
    const { fetchImpl } = makeFetchMock();
    const user = userEvent.setup();
    render(
      <NewSourceBindingModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await bootAndAdvanceToConfig(user, "asana", async () => {
      await user.type(
        document.querySelector("input[name='auth.personal_access_token']")!,
        "p",
      );
      await user.type(
        document.querySelector("input[name='auth.workspace_gid']")!,
        "w",
      );
      await user.type(
        document.querySelector("input[name='webhook_secret.x_hook_secret']")!,
        "h",
      );
    });
    const projectGid = document.querySelector(
      "input[name='projectGid']",
    ) as HTMLInputElement;
    expect(projectGid).not.toBeNull();
    expect(projectGid.dataset["secret"]).not.toBe("true");
    expect(projectGid.type).not.toBe("password");
  });

  it("polling-adapter (drive) submits with `config: { folderId, ... }` populated", async () => {
    const { fetchImpl, postCalls } = makeFetchMock();
    const user = userEvent.setup();
    render(
      <NewSourceBindingModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await bootAndAdvanceToConfig(user, "drive", async () => {
      await user.type(
        document.querySelector("input[name='service_account_json']")!,
        "json",
      );
      await user.type(
        document.querySelector("input[name='root_folder_id']")!,
        "1XYZ",
      );
    });
    await user.type(
      document.querySelector("input[name='folderId']")!,
      "1ABC",
    );
    await advanceFromConfigToAllowedPaths(user);
    await pickFirstSuggestionAndSubmit(user);

    await waitFor(() => expect(postCalls().length).toBe(1));
    const [, init] = postCalls()[0]!;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const config = body["config"] as Record<string, unknown>;
    expect(config).toBeDefined();
    expect(config["folderId"]).toBe("1ABC");
  });
});

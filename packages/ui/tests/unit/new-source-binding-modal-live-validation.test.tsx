/**
 * NewSourceBindingModal live-validation tests — wave-16 PR-B4.
 *
 * Pins the hook wiring for the source-binding wizard:
 *   - Picker step surfaces inline validation when adapter / target
 *     domain is empty.
 *   - Config-step cron-shaped fields parse via `cron-parser` on
 *     every keystroke (no submit-time round-trip).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NewSourceBindingModal } from "../../src/components/NewSourceBindingModal.js";

const DOMAINS_RESPONSE = {
  rows: [
    {
      id: "11111111-1111-1111-1111-111111111111",
      slug: "wiki-main",
      class: "knowledge",
    },
  ],
};

const ADAPTERS_RESPONSE_WITH_CRON = {
  adapters: [
    {
      slug: "drive",
      mode: "polling" as const,
      credentialSchema: {
        type: "object",
        properties: {
          service_account_json: {
            type: "string",
            secret: true,
            description: "JSON key",
          },
        },
        required: ["service_account_json"],
      },
      bindingConfigSchema: {
        type: "object",
        properties: {
          schedule_cron: {
            type: "string",
            description: "UTC cron pattern",
          },
        },
        required: [],
      },
    },
  ],
};

function makeFetchMock(
  adaptersResponse: object = ADAPTERS_RESPONSE_WITH_CRON,
): typeof fetch {
  return vi.fn(async (input: RequestInfo): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/admin/adapters") {
      return new Response(JSON.stringify(adaptersResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/admin/domains") {
      return new Response(JSON.stringify(DOMAINS_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("NewSourceBindingModal — live validation (PR-B4)", () => {
  it("config-step cron field flips to 'invalid' on a bad pattern, 'valid' on a good one", async () => {
    const fetchImpl = makeFetchMock();
    const user = userEvent.setup();
    render(
      <NewSourceBindingModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => {
      expect(
        document.querySelector("select[name='adapter_slug']"),
      ).not.toBeNull();
    });
    // Advance picker → credentials → config.
    await user.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => {
      expect(
        document.querySelector("input[name='service_account_json']"),
      ).not.toBeNull();
    });
    await user.type(
      document.querySelector("input[name='service_account_json']")!,
      "secret",
    );
    await user.click(screen.getByRole("button", { name: /next/i }));
    // Now on config step; the schedule_cron field should render.
    await waitFor(() => {
      expect(
        document.querySelector("input[name='schedule_cron']"),
      ).not.toBeNull();
    });
    const cronInput = document.querySelector(
      "input[name='schedule_cron']",
    ) as HTMLInputElement;
    // Type a bad cron.
    await user.type(cronInput, "garbage");
    expect(cronInput.value).toBe("garbage");
    await waitFor(() => {
      expect(cronInput).toHaveAttribute("aria-invalid", "true");
    });
    expect(screen.getByText(/Cron pattern is invalid/i)).toBeInTheDocument();
    // Clear + type a valid 5-field cron.
    await user.clear(cronInput);
    await user.type(cronInput, "0 8 * * 1-5");
    await waitFor(() => {
      expect(cronInput).not.toHaveAttribute("aria-invalid");
    });
  });
});

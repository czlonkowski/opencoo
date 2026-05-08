/**
 * CredentialForm tests — load-bearing pin per planner step 1:
 * `secret: true` properties render masked (HTML
 * `type="password"`), don't echo their value back, and surface
 * the design-system helper text.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CredentialForm, type CredentialSchema } from "../../src/components/CredentialForm.js";

const SCHEMA: CredentialSchema = {
  type: "object",
  properties: {
    n8nApiToken: { type: "string", secret: true, description: "n8n REST token" },
    baseUrl: { type: "string", description: "n8n base URL" },
  },
  required: ["n8nApiToken", "baseUrl"],
};

describe("CredentialForm", () => {
  it("renders a masked input for `secret: true` fields", () => {
    render(<CredentialForm schema={SCHEMA} onSubmit={() => undefined} />);
    const secret = document.querySelector("input[name='n8nApiToken']") as HTMLInputElement;
    expect(secret).not.toBeNull();
    expect(secret.type).toBe("password");
    expect(secret.dataset["secret"]).toBe("true");
  });

  it("renders non-secret fields with type=text and mono helper", () => {
    render(<CredentialForm schema={SCHEMA} onSubmit={() => undefined} />);
    const baseUrl = document.querySelector("input[name='baseUrl']") as HTMLInputElement;
    expect(baseUrl.type).toBe("text");
    expect(baseUrl.dataset["secret"]).toBeUndefined();
  });

  it("rejects submit with missing required fields and surfaces field-level errors", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<CredentialForm schema={SCHEMA} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button"));
    expect(onSubmit).not.toHaveBeenCalled();
    // Both required fields surface the "Required." translation.
    const errors = screen.getAllByText(/Required\./i);
    expect(errors.length).toBe(2);
  });

  it("calls onSubmit with the entered values when all required fields are filled", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<CredentialForm schema={SCHEMA} onSubmit={onSubmit} />);
    await user.type(document.querySelector("input[name='n8nApiToken']")!, "tok123");
    await user.type(document.querySelector("input[name='baseUrl']")!, "https://n8n");
    await user.click(screen.getByRole("button"));
    expect(onSubmit).toHaveBeenCalledWith({
      n8nApiToken: "tok123",
      baseUrl: "https://n8n",
    });
  });

  it("surfaces the `stored encrypted` mono-note for `secret: true` fields", () => {
    const { container } = render(<CredentialForm schema={SCHEMA} onSubmit={() => undefined} />);
    // The note is split across an SVG glyph + text node — match
    // on the container's full textContent.
    expect(container.textContent).toMatch(/stored encrypted/i);
  });

  it("renders the field description below the label when present", () => {
    render(<CredentialForm schema={SCHEMA} onSubmit={() => undefined} />);
    // Both schema entries set a description.
    expect(screen.getByText("n8n REST token")).toBeInTheDocument();
    expect(screen.getByText("n8n base URL")).toBeInTheDocument();
  });

  it("surfaces `· required` and `· optional` markers per field", () => {
    const schemaWithOptional: CredentialSchema = {
      type: "object",
      properties: {
        token: { type: "string", secret: true },
        nickname: { type: "string" },
      },
      required: ["token"],
    };
    render(<CredentialForm schema={schemaWithOptional} onSubmit={() => undefined} />);
    // Both markers visible — required for token, optional for nickname.
    expect(screen.getByText(/· required/i)).toBeInTheDocument();
    expect(screen.getByText(/· optional/i)).toBeInTheDocument();
  });

  describe("grouped (dot-path) field keys — PR-Q11", () => {
    const GROUPED_SCHEMA: CredentialSchema = {
      type: "object",
      properties: {
        "auth.personal_access_token": {
          type: "string",
          secret: true,
          description: "Gitea PAT",
        },
        "auth.workspace_gid": { type: "string", description: "workspace id" },
        "webhook_secret.x_hook_secret": { type: "string", secret: true },
      },
      required: [
        "auth.personal_access_token",
        "auth.workspace_gid",
        "webhook_secret.x_hook_secret",
      ],
    };

    it("renders ONE 'Auth' section heading above the first field of that section", () => {
      render(<CredentialForm schema={GROUPED_SCHEMA} onSubmit={() => undefined} />);
      const headings = screen.getAllByText("Auth", { selector: "[data-section-heading]" });
      expect(headings.length).toBe(1);
    });

    it("renders 'Webhook secret' as the second section heading (humanised, not 'Webhook_secret')", () => {
      render(<CredentialForm schema={GROUPED_SCHEMA} onSubmit={() => undefined} />);
      const heading = screen.getByText("Webhook secret", {
        selector: "[data-section-heading]",
      });
      expect(heading).toBeInTheDocument();
      // Sanity: raw underscored form not present as a heading.
      expect(
        screen.queryByText("Webhook_secret", { selector: "[data-section-heading]" }),
      ).toBeNull();
    });

    it("renders the leaf as a humanised label, not the dot-path", () => {
      render(<CredentialForm schema={GROUPED_SCHEMA} onSubmit={() => undefined} />);
      // First-letter capital, underscores → spaces, lowercase rest.
      expect(screen.getByText("Personal access token")).toBeInTheDocument();
      expect(screen.getByText("Workspace gid")).toBeInTheDocument();
      expect(screen.getByText("X hook secret")).toBeInTheDocument();
      // Negative: the dot-path leak is gone.
      expect(screen.queryByText("auth.personal_access_token")).toBeNull();
      expect(screen.queryByText("auth.workspace_gid")).toBeNull();
      expect(screen.queryByText("webhook_secret.x_hook_secret")).toBeNull();
    });

    it("still surfaces the `· required` marker next to a leaf label", () => {
      render(<CredentialForm schema={GROUPED_SCHEMA} onSubmit={() => undefined} />);
      // Three required fields → three "· required" markers.
      const markers = screen.getAllByText(/· required/i);
      expect(markers.length).toBe(3);
    });

    it("still surfaces the `stored encrypted` mono-note for grouped secret fields", () => {
      const { container } = render(
        <CredentialForm schema={GROUPED_SCHEMA} onSubmit={() => undefined} />,
      );
      // Two secret fields → two filled-disc glyphs in the encrypted-note spans.
      const glyphs = container.querySelectorAll("svg title");
      const titles = Array.from(glyphs)
        .map((t) => t.textContent ?? "")
        .filter((s) => /stored encrypted/i.test(s));
      expect(titles.length).toBe(2);
    });

    it("preserves dot-keyed names on inputs and submits dot-keyed values", async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();
      render(<CredentialForm schema={GROUPED_SCHEMA} onSubmit={onSubmit} />);
      const pat = document.querySelector(
        "input[name='auth.personal_access_token']",
      ) as HTMLInputElement;
      const gid = document.querySelector(
        "input[name='auth.workspace_gid']",
      ) as HTMLInputElement;
      const hook = document.querySelector(
        "input[name='webhook_secret.x_hook_secret']",
      ) as HTMLInputElement;
      expect(pat).not.toBeNull();
      expect(gid).not.toBeNull();
      expect(hook).not.toBeNull();
      // data-secret attribute preserved on grouped secret fields.
      expect(pat.dataset["secret"]).toBe("true");
      expect(hook.dataset["secret"]).toBe("true");
      expect(gid.dataset["secret"]).toBeUndefined();

      await user.type(pat, "tokABC");
      await user.type(gid, "1234567890");
      await user.type(hook, "shh");
      await user.click(screen.getByRole("button"));

      // Dot-keyed body — the parent modal nests these via `auth[k] = body['auth.${k}']`.
      expect(onSubmit).toHaveBeenCalledWith({
        "auth.personal_access_token": "tokABC",
        "auth.workspace_gid": "1234567890",
        "webhook_secret.x_hook_secret": "shh",
      });
    });
  });

  it("submit button label swaps to `saving…` while submitting (no spinner)", async () => {
    let resolveOuter: (() => void) | undefined;
    const onSubmit = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveOuter = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<CredentialForm schema={SCHEMA} onSubmit={onSubmit} />);
    await user.type(document.querySelector("input[name='n8nApiToken']")!, "tok");
    await user.type(document.querySelector("input[name='baseUrl']")!, "url");
    void user.click(screen.getByRole("button"));
    // Wait one tick so React commits the submitting state.
    await new Promise((r) => setTimeout(r, 10));
    const btn = screen.getByRole("button") as HTMLButtonElement;
    expect(btn.textContent).toMatch(/saving…/i);
    expect(btn.disabled).toBe(true);
    resolveOuter?.();
  });
});

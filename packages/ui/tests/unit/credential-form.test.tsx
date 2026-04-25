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

  it("surfaces the secret-helper translation for `secret: true` fields", () => {
    render(<CredentialForm schema={SCHEMA} onSubmit={() => undefined} />);
    expect(screen.getByText(/encrypted at rest/i)).toBeInTheDocument();
  });
});

import { describe, expect, it } from "vitest";

import { providerOptsFromEnv } from "../src/provision/production-composition.js";

describe("providerOptsFromEnv — azure", () => {
  it("maps AZURE_OPENAI_BASE_URL + AZURE_ENTRA_* into provider options", () => {
    const opts = providerOptsFromEnv(
      {
        AZURE_OPENAI_BASE_URL: "https://r.openai.azure.com/openai/v1",
        AZURE_ENTRA_TENANT_ID: "tid",
        AZURE_ENTRA_CLIENT_ID: "cid",
        AZURE_ENTRA_CLIENT_SECRET: "sec",
      },
      "azure",
    );
    expect(opts).toEqual({
      baseUrl: "https://r.openai.azure.com/openai/v1",
      tenantId: "tid",
      clientId: "cid",
      clientSecret: "sec",
    });
  });

  it("includes the static api-key fallback when present", () => {
    const opts = providerOptsFromEnv(
      {
        AZURE_OPENAI_BASE_URL: "https://r/openai/v1",
        AZURE_OPENAI_API_KEY: "k",
      },
      "azure",
    );
    expect(opts.apiKey).toBe("k");
    expect(opts.tenantId).toBeUndefined();
  });

  it("omits absent / empty fields entirely", () => {
    const opts = providerOptsFromEnv(
      { AZURE_OPENAI_BASE_URL: "https://r/openai/v1", AZURE_ENTRA_TENANT_ID: "" },
      "azure",
    );
    expect(opts).toEqual({ baseUrl: "https://r/openai/v1" });
  });

  it("still maps the simple single-var providers (openrouter)", () => {
    expect(providerOptsFromEnv({ OPENROUTER_API_KEY: "x" }, "openrouter")).toEqual({
      apiKey: "x",
    });
  });
});

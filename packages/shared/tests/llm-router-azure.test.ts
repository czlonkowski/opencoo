import { describe, expect, it } from "vitest";

import { LlmProviderError } from "../src/llm-router/errors.js";
import {
  createAzureEntraProvider,
  createEntraTokenSource,
} from "../src/llm-router/providers/azure.js";

function tokenResponse(token: string, expiresIn = 3600): Response {
  return new Response(
    JSON.stringify({ access_token: token, expires_in: expiresIn }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("createEntraTokenSource", () => {
  it("mints a token then serves it from cache until near expiry", async () => {
    let calls = 0;
    let clock = 1_000_000;
    const fetchImpl = (async () => {
      calls += 1;
      return tokenResponse(`tok-${calls}`, 3600);
    }) as unknown as typeof fetch;

    const getToken = createEntraTokenSource({
      tenantId: "test-tenant",
      clientId: "test-client",
      clientSecret: "test-secret",
      fetchImpl,
      now: () => clock,
    });

    expect(await getToken()).toBe("tok-1");
    expect(await getToken()).toBe("tok-1"); // served from cache
    expect(calls).toBe(1);

    clock += 3_600_000; // advance past expiry
    expect(await getToken()).toBe("tok-2");
    expect(calls).toBe(2);
  });

  it("POSTs client-credentials to the tenant token endpoint with the cognitive-services scope", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const fetchImpl = (async (url: unknown, init: { body?: unknown }) => {
      capturedUrl = String(url);
      capturedBody = String(init.body);
      return tokenResponse("tok");
    }) as unknown as typeof fetch;

    const getToken = createEntraTokenSource({
      tenantId: "my-tenant",
      clientId: "cid",
      clientSecret: "sec",
      fetchImpl,
    });
    await getToken();

    expect(capturedUrl).toContain("/my-tenant/oauth2/v2.0/token");
    expect(capturedBody).toContain("grant_type=client_credentials");
    expect(capturedBody).toContain("cognitiveservices.azure.com");
  });

  it("throws on a non-OK token response", async () => {
    const fetchImpl = (async () =>
      new Response("denied", { status: 401 })) as unknown as typeof fetch;
    const getToken = createEntraTokenSource({
      tenantId: "t",
      clientId: "c",
      clientSecret: "s",
      fetchImpl,
    });
    await expect(getToken()).rejects.toThrow();
  });
});

describe("createAzureEntraProvider", () => {
  it("returns a provider with .generate for Entra creds + baseUrl", async () => {
    const provider = await createAzureEntraProvider({
      baseUrl: "https://example.openai.azure.com/openai/v1",
      tenantId: "t",
      clientId: "c",
      clientSecret: "s",
    });
    expect(typeof provider.generate).toBe("function");
  });

  it("throws when baseUrl is missing", async () => {
    await expect(
      createAzureEntraProvider({ tenantId: "t", clientId: "c", clientSecret: "s" }),
    ).rejects.toThrow(/baseUrl|AZURE_OPENAI_BASE_URL/);
  });

  it("throws LlmProviderError when neither Entra creds nor apiKey supplied", async () => {
    await expect(
      createAzureEntraProvider({ baseUrl: "https://example.openai.azure.com/openai/v1" }),
    ).rejects.toThrow(LlmProviderError);
  });
});

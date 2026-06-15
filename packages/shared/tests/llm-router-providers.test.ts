/**
 * Provider factory tests — covers `createProvider` dispatch and
 * the per-provider option threading. PR-Q4 (phase-a appendix #9)
 * adds the `openrouter` arm so `domains.llm_policy.thinker.provider`
 * can be set to `"openrouter"` in production (previously the
 * factory only allowed openai / anthropic / google / ollama, even
 * though `createOpenRouterProvider` existed for the real-LLM tests).
 *
 * Tests are isolated to the factory: they assert the dispatch
 * shape (right factory called, right options threaded) without
 * making any network calls. We rely on the underlying provider
 * factories' *construction-time* contracts (each one returns an
 * object with `.generate()`) — actual `generate()` calls would
 * need a real or mocked SDK and are covered by `llm-router.test.ts`
 * via the `MockLlmClient`.
 */
import { describe, expect, it } from "vitest";

import { LlmProviderError } from "../src/llm-router/errors.js";
import { llmPolicySchema, PROVIDERS } from "../src/llm-router/llm-policy.js";
import { createProvider } from "../src/llm-router/providers/index.js";

describe("PROVIDERS tuple — closed enum of supported provider names", () => {
  it("includes 'openrouter' so domain LLM policy can target it", () => {
    expect(PROVIDERS).toContain("openrouter");
  });

  it("still includes the original four providers", () => {
    expect(PROVIDERS).toContain("openai");
    expect(PROVIDERS).toContain("anthropic");
    expect(PROVIDERS).toContain("google");
    expect(PROVIDERS).toContain("ollama");
  });

  it("includes 'azure' so domain LLM policy can target Azure OpenAI", () => {
    expect(PROVIDERS).toContain("azure");
  });
});

describe("llmPolicySchema — accepts openrouter as a tier provider", () => {
  it("parses a policy with provider='openrouter' for all three tiers", () => {
    const result = llmPolicySchema.safeParse({
      thinker: { provider: "openrouter", model: "moonshotai/kimi-k2.6" },
      worker: { provider: "openrouter", model: "moonshotai/kimi-k2.6" },
      light: { provider: "openrouter", model: "moonshotai/kimi-k2.6" },
      local_only: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a policy with an unknown provider name", () => {
    const result = llmPolicySchema.safeParse({
      thinker: { provider: "not-a-real-provider", model: "x" },
      worker: { provider: "openai", model: "gpt-4o-mini" },
      light: { provider: "openai", model: "gpt-4o-mini" },
    });
    expect(result.success).toBe(false);
  });
});

describe("createProvider('openrouter', ...)", () => {
  it("returns a provider with a `.generate` function when apiKey is supplied", async () => {
    const provider = await createProvider("openrouter", { apiKey: "test" });
    expect(typeof provider.generate).toBe("function");
  });

  it("throws LlmProviderError naming OPENROUTER_API_KEY when apiKey is absent", async () => {
    await expect(createProvider("openrouter", {})).rejects.toThrow(
      LlmProviderError,
    );
    await expect(createProvider("openrouter", {})).rejects.toThrow(
      /OPENROUTER_API_KEY/,
    );
  });

  it("throws LlmProviderError when apiKey is the empty string", async () => {
    await expect(
      createProvider("openrouter", { apiKey: "" }),
    ).rejects.toThrow(/OPENROUTER_API_KEY/);
  });
});

describe("llmPolicySchema — accepts azure as a tier provider", () => {
  it("parses a policy with provider='azure' for the thinker tier", () => {
    const result = llmPolicySchema.safeParse({
      thinker: { provider: "azure", model: "gpt55test" },
      worker: { provider: "openrouter", model: "moonshotai/kimi-k2.6" },
      light: { provider: "openrouter", model: "moonshotai/kimi-k2.6" },
      local_only: false,
    });
    expect(result.success).toBe(true);
  });
});

describe("createProvider('azure', ...)", () => {
  it("returns a provider with `.generate` when Entra creds + baseUrl supplied", async () => {
    const provider = await createProvider("azure", {
      baseUrl: "https://example.openai.azure.com/openai/v1",
      tenantId: "t",
      clientId: "c",
      clientSecret: "s",
    });
    expect(typeof provider.generate).toBe("function");
  });

  it("throws LlmProviderError when no credentials are supplied", async () => {
    await expect(
      createProvider("azure", {
        baseUrl: "https://example.openai.azure.com/openai/v1",
      }),
    ).rejects.toThrow(LlmProviderError);
  });
});

describe("createProvider — parity with existing providers", () => {
  // These mirror the openrouter cases above to keep the factory
  // contract consistent across the four cloud providers. We don't
  // assert apiKey-missing failure for openai/anthropic/google
  // because their underlying SDKs lazy-validate the credential at
  // call time (the current behaviour, intentionally permissive so
  // the operator's `.env` rotation doesn't crash boot).
  it("returns a working provider for openai", async () => {
    const provider = await createProvider("openai", { apiKey: "test" });
    expect(typeof provider.generate).toBe("function");
  });

  it("returns a working provider for anthropic", async () => {
    const provider = await createProvider("anthropic", { apiKey: "test" });
    expect(typeof provider.generate).toBe("function");
  });

  it("returns a working provider for google", async () => {
    const provider = await createProvider("google", { apiKey: "test" });
    expect(typeof provider.generate).toBe("function");
  });

  it("returns a working provider for ollama (baseUrl-based)", async () => {
    const provider = await createProvider("ollama", {
      baseUrl: "http://localhost:11434",
    });
    expect(typeof provider.generate).toBe("function");
  });
});

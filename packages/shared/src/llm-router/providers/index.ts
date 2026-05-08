import { LlmProviderError } from "../errors.js";
import type { LlmProvider } from "../interface.js";
import type { ProviderName } from "../llm-policy.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createGoogleProvider } from "./google.js";
import { createOllamaProvider } from "./ollama.js";
import { createOpenAiProvider } from "./openai.js";
import { createOpenRouterProvider } from "./openrouter.js";

export interface ProviderOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

// Conditional-spread helpers for `exactOptionalPropertyTypes` — the
// provider factories reject `{ apiKey: undefined }` as a type error,
// so undefined-valued keys must be omitted entirely.
function apiKeyOpts(opts: ProviderOptions): { apiKey?: string } {
  return opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {};
}

function baseUrlOpts(opts: ProviderOptions): { baseUrl?: string } {
  return opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {};
}

export async function createProvider(
  name: ProviderName,
  opts: ProviderOptions = {},
): Promise<LlmProvider> {
  switch (name) {
    case "openai":
      return createOpenAiProvider(apiKeyOpts(opts));
    case "anthropic":
      return createAnthropicProvider(apiKeyOpts(opts));
    case "google":
      return createGoogleProvider(apiKeyOpts(opts));
    case "ollama":
      return createOllamaProvider(baseUrlOpts(opts));
    case "openrouter":
      return createOpenRouterProvider(apiKeyOpts(opts));
    default:
      throw new LlmProviderError(`Unknown provider: ${name as string}`);
  }
}

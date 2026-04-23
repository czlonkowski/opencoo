import { LlmProviderError } from "../errors.js";
import type { LlmProvider } from "../interface.js";
import type { ProviderName } from "../llm-policy.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createGoogleProvider } from "./google.js";
import { createOllamaProvider } from "./ollama.js";
import { createOpenAiProvider } from "./openai.js";

export interface ProviderOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

export async function createProvider(
  name: ProviderName,
  opts: ProviderOptions = {},
): Promise<LlmProvider> {
  switch (name) {
    case "openai":
      return createOpenAiProvider(
        opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {},
      );
    case "anthropic":
      return createAnthropicProvider(
        opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {},
      );
    case "google":
      return createGoogleProvider(
        opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {},
      );
    case "ollama":
      return createOllamaProvider(
        opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {},
      );
    default:
      throw new LlmProviderError(`Unknown provider: ${name as string}`);
  }
}

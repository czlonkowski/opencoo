import { LlmProviderError } from "../errors.js";
import type { LlmProvider } from "../interface.js";
import type { ProviderName } from "../llm-policy.js";
import { createAnthropicProvider } from "./anthropic.js";
import {
  type AzureEntraProviderOptions,
  createAzureEntraProvider,
} from "./azure.js";
import { createGoogleProvider } from "./google.js";
import { createOllamaProvider } from "./ollama.js";
import { createOpenAiProvider } from "./openai.js";
import { createOpenRouterProvider } from "./openrouter.js";

export interface ProviderOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  // Azure-only: Entra service-principal credentials.
  readonly tenantId?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly scope?: string;
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

function azureOpts(opts: ProviderOptions): AzureEntraProviderOptions {
  return {
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
    ...(opts.clientId !== undefined ? { clientId: opts.clientId } : {}),
    ...(opts.clientSecret !== undefined
      ? { clientSecret: opts.clientSecret }
      : {}),
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
  };
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
    case "azure":
      return createAzureEntraProvider(azureOpts(opts));
    default:
      throw new LlmProviderError(`Unknown provider: ${name as string}`);
  }
}

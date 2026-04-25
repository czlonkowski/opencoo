// Lazy provider module for OpenRouter (test-only, gated on
// RUN_REAL_LLM=1 in the engine-ingestion classifier injection
// corpus). OpenRouter speaks the OpenAI Chat Completions wire
// format, so we drive it through `@ai-sdk/openai-compatible`.
//
// This file lives alongside the four production providers
// (openai, anthropic, google, ollama) so the existing
// `opencoo/no-direct-llm-sdk` ESLint allowlist
// (packages/shared/src/llm-router/providers/**) covers it. It is
// NOT wired into the closed PROVIDERS tuple in llm-policy.ts —
// production code never selects it; only the corpus driver
// constructs it directly.
//
// Spec: https://openrouter.ai/docs#api  (OpenAI-compatible v1)

import { generateText as aiGenerateText } from "ai";

import { LlmProviderError } from "../errors.js";
import type {
  LlmProvider,
  LlmProviderCall,
  LlmProviderResponse,
} from "../interface.js";

export interface OpenRouterProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
}

export async function createOpenRouterProvider(
  opts: OpenRouterProviderOptions,
): Promise<LlmProvider> {
  let mod: typeof import("@ai-sdk/openai-compatible");
  try {
    mod = await import("@ai-sdk/openai-compatible");
  } catch (err) {
    throw new LlmProviderError(
      "Install `@ai-sdk/openai-compatible` to use the OpenRouter provider",
      { cause: err },
    );
  }

  const client = mod.createOpenAICompatible({
    name: "openrouter",
    baseURL: opts.baseUrl ?? "https://openrouter.ai/api/v1",
    apiKey: opts.apiKey,
  });

  return {
    async generate(call: LlmProviderCall): Promise<LlmProviderResponse> {
      try {
        const result = await aiGenerateText({
          model: client(call.model),
          prompt: call.prompt,
        });
        return {
          text: result.text,
          tokensIn: result.usage.inputTokens ?? 0,
          tokensOut: result.usage.outputTokens ?? 0,
        };
      } catch (err) {
        throw new LlmProviderError("OpenRouter provider call failed", {
          cause: err,
        });
      }
    },
  };
}

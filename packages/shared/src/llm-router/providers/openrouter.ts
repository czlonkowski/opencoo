// Lazy provider module for OpenRouter. OpenRouter speaks the
// OpenAI Chat Completions wire format, so we drive it through
// `@ai-sdk/openai-compatible`.
//
// This file lives alongside the four other providers
// (openai, anthropic, google, ollama) so the existing
// `opencoo/no-direct-llm-sdk` ESLint allowlist
// (packages/shared/src/llm-router/providers/**) covers it.
//
// Phase-a appendix #9 PR-Q4: wired into the closed PROVIDERS
// tuple in llm-policy.ts so domain LLM policy can target
// `provider: "openrouter"` directly. Previously the factory was
// reachable only through the real-LLM corpus driver — production
// code paths threw `Unknown provider: openrouter` because the
// closed tuple rejected the value.
//
// Spec: https://openrouter.ai/docs#api  (OpenAI-compatible v1)

import { generateText as aiGenerateText } from "ai";

import { LlmProviderError, LlmProviderTransientError } from "../errors.js";
import type {
  LlmProvider,
  LlmProviderCall,
  LlmProviderResponse,
} from "../interface.js";
import { isRetryableProviderError } from "../structured-output.js";

export interface OpenRouterProviderOptions {
  // `apiKey` is optional at the type level so the multi-provider
  // dispatcher in `production-composition.ts` can call this
  // factory uniformly with `apiKeyOpts(opts)` (which omits the
  // field entirely when `OPENROUTER_API_KEY` is unset). At
  // runtime we require it — see the construction-time guard
  // below. A missing key surfaces a clear `LlmProviderError`
  // naming `OPENROUTER_API_KEY` instead of a downstream HTTP
  // 401 from `@ai-sdk/openai-compatible`.
  readonly apiKey?: string;
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

  if (opts.apiKey === undefined || opts.apiKey.length === 0) {
    throw new LlmProviderError(
      "OpenRouter provider requires apiKey (set OPENROUTER_API_KEY)",
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
        if (isRetryableProviderError(err)) {
          throw new LlmProviderTransientError(
            "OpenRouter provider call failed",
            { cause: err },
          );
        }
        throw new LlmProviderError("OpenRouter provider call failed", {
          cause: err,
        });
      }
    },
  };
}

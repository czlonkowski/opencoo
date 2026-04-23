// Lazy provider module for OpenAI. This file is ONE of the four
// places in the opencoo repo that may import `@ai-sdk/*` directly —
// the `opencoo/no-direct-llm-sdk` ESLint rule allowlists
// `packages/shared/src/llm-router/providers/**` for exactly this
// reason. Any other code path must go through `LlmRouter`.

import { generateText as aiGenerateText } from "ai";

import { LlmProviderError } from "../errors.js";
import type {
  LlmProvider,
  LlmProviderCall,
  LlmProviderResponse,
} from "../interface.js";

export interface OpenAiProviderOptions {
  readonly apiKey?: string;
}

export async function createOpenAiProvider(
  opts: OpenAiProviderOptions = {},
): Promise<LlmProvider> {
  let mod: typeof import("@ai-sdk/openai");
  try {
    mod = await import("@ai-sdk/openai");
  } catch (err) {
    throw new LlmProviderError(
      "Install `@ai-sdk/openai` to use the OpenAI provider",
      { cause: err },
    );
  }

  const client = opts.apiKey
    ? mod.createOpenAI({ apiKey: opts.apiKey })
    : mod.openai;

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
        throw new LlmProviderError(`OpenAI provider call failed`, {
          cause: err,
        });
      }
    },
  };
}

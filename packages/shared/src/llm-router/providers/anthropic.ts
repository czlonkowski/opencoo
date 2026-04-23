import { generateText as aiGenerateText } from "ai";

import { LlmProviderError } from "../errors.js";
import type {
  LlmProvider,
  LlmProviderCall,
  LlmProviderResponse,
} from "../interface.js";

export interface AnthropicProviderOptions {
  readonly apiKey?: string;
}

export async function createAnthropicProvider(
  opts: AnthropicProviderOptions = {},
): Promise<LlmProvider> {
  let mod: typeof import("@ai-sdk/anthropic");
  try {
    mod = await import("@ai-sdk/anthropic");
  } catch (err) {
    throw new LlmProviderError(
      "Install `@ai-sdk/anthropic` to use the Anthropic provider",
      { cause: err },
    );
  }

  const client = opts.apiKey
    ? mod.createAnthropic({ apiKey: opts.apiKey })
    : mod.anthropic;

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
        throw new LlmProviderError(`Anthropic provider call failed`, {
          cause: err,
        });
      }
    },
  };
}

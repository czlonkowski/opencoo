import { generateText as aiGenerateText } from "ai";

import { LlmProviderError } from "../errors.js";
import type {
  LlmProvider,
  LlmProviderCall,
  LlmProviderResponse,
} from "../interface.js";

export interface GoogleProviderOptions {
  readonly apiKey?: string;
}

export async function createGoogleProvider(
  opts: GoogleProviderOptions = {},
): Promise<LlmProvider> {
  let mod: typeof import("@ai-sdk/google");
  try {
    mod = await import("@ai-sdk/google");
  } catch (err) {
    throw new LlmProviderError(
      "Install `@ai-sdk/google` to use the Google provider",
      { cause: err },
    );
  }

  const client = opts.apiKey
    ? mod.createGoogleGenerativeAI({ apiKey: opts.apiKey })
    : mod.google;

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
        throw new LlmProviderError(`Google provider call failed`, {
          cause: err,
        });
      }
    },
  };
}

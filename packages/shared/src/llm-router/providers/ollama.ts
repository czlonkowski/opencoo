import { generateText as aiGenerateText } from "ai";

import { LlmProviderError } from "../errors.js";
import type {
  LlmProvider,
  LlmProviderCall,
  LlmProviderResponse,
} from "../interface.js";

export interface OllamaProviderOptions {
  readonly baseUrl?: string;
}

// Ollama is wired through `@ai-sdk/openai-compatible` — Ollama exposes
// a subset of the OpenAI REST API shape. Default baseUrl follows the
// conventional `http://localhost:11434/v1` path. Local-only domains
// use this provider exclusively (enforced upstream in the router).
export async function createOllamaProvider(
  opts: OllamaProviderOptions = {},
): Promise<LlmProvider> {
  let mod: typeof import("@ai-sdk/openai-compatible");
  try {
    mod = await import("@ai-sdk/openai-compatible");
  } catch (err) {
    throw new LlmProviderError(
      "Install `@ai-sdk/openai-compatible` to use the Ollama provider",
      { cause: err },
    );
  }

  const baseURL = opts.baseUrl ?? "http://localhost:11434/v1";
  const client = mod.createOpenAICompatible({
    name: "ollama",
    baseURL,
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
        throw new LlmProviderError(`Ollama provider call failed`, {
          cause: err,
        });
      }
    },
  };
}

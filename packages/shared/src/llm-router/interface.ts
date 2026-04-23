import type { z } from "zod";

import type { DomainId } from "../db/brands.js";
import type { Tier } from "./llm-policy.js";

export interface GenerateOpts {
  readonly domainId: DomainId;
  readonly tier: Tier;
  readonly pipelineOrAgent: string;
  readonly prompt: string;
  readonly documentId?: string;
}

export interface GenerateObjectOpts<T> extends GenerateOpts {
  readonly schema: z.ZodType<T>;
}

export interface GenerateTextResult {
  readonly text: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly model: string;
}

export interface GenerateObjectResult<T> {
  readonly object: T;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly model: string;
}

// Provider surface — the router dispatches through this abstraction
// rather than touching `@ai-sdk/*` directly in the hot path. Lazy
// provider modules in `providers/` construct an `LlmProvider` at
// boot; the MockLlmClient used in tests satisfies the same interface
// without touching any SDK.
export interface LlmProviderCall {
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;
}

export interface LlmProviderResponse {
  readonly text: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export interface LlmProvider {
  generate(call: LlmProviderCall): Promise<LlmProviderResponse>;
}

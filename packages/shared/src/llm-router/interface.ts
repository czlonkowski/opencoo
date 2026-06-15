import type { z } from "zod";

import type { DomainId } from "../db/brands.js";
import type { Tier } from "./llm-policy.js";

export interface GenerateOpts {
  readonly domainId: DomainId;
  readonly tier: Tier;
  readonly pipelineOrAgent: string;
  readonly prompt: string;
  readonly documentId?: string;
  // Usage attribution. `engine` defaults to "ingestion"; self-op
  // agents pass "self-op" (the harness injects it) so llm_usage
  // distinguishes engine spend. `runId` ties the row to an
  // agent_runs row so per-run token/cost totals can be aggregated.
  readonly engine?: "ingestion" | "self-op";
  readonly runId?: string;
}

export interface GenerateObjectOpts<T> extends GenerateOpts {
  readonly schema: z.ZodType<T>;
  // Number of repair re-prompts allowed when the model's output fails
  // JSON parse / schema validation. Total provider calls = 1 + this.
  // Defaults to 2 (router-side) — only failing calls pay the extra
  // cost, so the bound is on errors, not the happy path.
  readonly maxRepairAttempts?: number;
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

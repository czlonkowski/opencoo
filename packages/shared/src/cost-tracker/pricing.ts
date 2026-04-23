import type { Logger } from "../logger.js";

// Per-token pricing for supported models as of 2026-Q2. Numbers are
// USD per SINGLE token (not per thousand) to avoid a mental unit
// shift at call sites. Update as vendor price sheets change — a
// stale entry that's too low lets cost slip past the cap; too high
// just over-reserves budget (fail-safe). The budget-cap path reads
// these directly; do not fork the constants into a second source.
export interface PricingEntry {
  readonly inputPerToken: number;
  readonly outputPerToken: number;
}

export const PRICING: Readonly<Record<string, PricingEntry>> = {
  // OpenAI (2026 rates; per-token = per-1M/1e6).
  "gpt-4o-mini": { inputPerToken: 0.00000015, outputPerToken: 0.0000006 },
  "gpt-4o": { inputPerToken: 0.0000025, outputPerToken: 0.00001 },
  "gpt-4-turbo": { inputPerToken: 0.00001, outputPerToken: 0.00003 },
  "o1-mini": { inputPerToken: 0.0000011, outputPerToken: 0.0000044 },
  // Anthropic.
  "claude-3-5-sonnet-latest": {
    inputPerToken: 0.000003,
    outputPerToken: 0.000015,
  },
  "claude-3-5-haiku-latest": {
    inputPerToken: 0.0000008,
    outputPerToken: 0.000004,
  },
  "claude-3-opus-latest": {
    inputPerToken: 0.000015,
    outputPerToken: 0.000075,
  },
  // Google.
  "gemini-2.0-flash": { inputPerToken: 0.0000001, outputPerToken: 0.0000004 },
  "gemini-1.5-pro": { inputPerToken: 0.00000125, outputPerToken: 0.000005 },
};

// Used when the model name isn't in PRICING. Chosen to be slightly
// higher than the cheapest known model so the budget-cap path
// overestimates rather than under-counts an unknown call. A warn-
// level log event fires once so ops sees the unknown model.
export const FALLBACK_PRICING: PricingEntry = {
  inputPerToken: 0.000003,
  outputPerToken: 0.000015,
};

export interface CostForOptions {
  readonly logger?: Logger;
}

export function costFor(
  model: string,
  tokensIn: number,
  tokensOut: number,
  options: CostForOptions = {},
): number {
  const entry = PRICING[model];
  if (entry === undefined) {
    options.logger?.warn("cost-tracker.unknown_model", { model });
  }
  const rates = entry ?? FALLBACK_PRICING;
  return tokensIn * rates.inputPerToken + tokensOut * rates.outputPerToken;
}

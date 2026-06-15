export {
  LlmBudgetExceededError,
  LlmPolicyViolationError,
  LlmProviderError,
  LlmProviderTransientError,
} from "./errors.js";
export {
  buildRepairPrompt,
  extractJsonCandidate,
  formatSchemaError,
  isRetryableProviderError,
  REPAIR_INSTRUCTION,
} from "./structured-output.js";
export {
  FALLBACK_POLICY,
  llmPolicySchema,
  llmPolicyTierSchema,
  PROVIDERS,
  type LlmPolicy,
  type ProviderName,
  type Tier,
} from "./llm-policy.js";
// PR-Q13 / phase-a appendix #9 — static model catalog seeded
// into the LLM-policy editor's per-tier model dropdown. Lives
// in shared so the admin-API endpoint AND the editor consume
// the same source of truth.
export { MODEL_CATALOG } from "./model-catalog.js";
export {
  InMemoryQueuePauser,
  type QueuePauser,
} from "./queue-pauser.js";
export {
  type GenerateObjectOpts,
  type GenerateObjectResult,
  type GenerateOpts,
  type GenerateTextResult,
  type LlmProvider,
  type LlmProviderCall,
  type LlmProviderResponse,
} from "./interface.js";
export {
  LlmRouter,
  type LlmRouterDb,
  type LlmRouterOptions,
} from "./router.js";
export { MockLlmClient } from "./testing/mock-llm-client.js";

// OpenRouter provider helper. Used by the real-LLM test driver
// (RUN_REAL_LLM=1 / classifier injection corpus) for direct
// construction; in production it's reached via `createProvider`
// (PR-Q4, phase-a appendix #9 — `"openrouter"` is now part of
// the closed PROVIDERS tuple).
export {
  createOpenRouterProvider,
  type OpenRouterProviderOptions,
} from "./providers/openrouter.js";

// Production multi-provider dispatcher factory (PR-M2, phase-a
// appendix #5). The CLI's serve.ts composition root calls
// `createProvider(name, opts)` per `LlmProviderCall.provider` to
// route the LLM call to the right `@ai-sdk/*` package.
export {
  createProvider,
  type ProviderOptions,
} from "./providers/index.js";

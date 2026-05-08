import { z } from "zod";

export const PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "ollama",
  "openrouter",
] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const llmPolicyTierSchema = z.object({
  provider: z.enum(PROVIDERS),
  model: z.string().min(1),
});

export const llmPolicySchema = z.object({
  thinker: llmPolicyTierSchema,
  worker: llmPolicyTierSchema,
  light: llmPolicyTierSchema,
  local_only: z.boolean().default(false),
});

export type LlmPolicy = z.infer<typeof llmPolicySchema>;
export type Tier = "thinker" | "worker" | "light";

// Sensible default used when `domains.llm_policy` is `{}` (i.e. the
// operator hasn't picked providers yet). All three tiers point at
// `gpt-4o-mini` so first-run behaviour is cheap and predictable; the
// router emits a warn log so ops notices and configures a real
// policy via the Management UI (PR 29).
export const FALLBACK_POLICY: LlmPolicy = {
  thinker: { provider: "openai", model: "gpt-4o-mini" },
  worker: { provider: "openai", model: "gpt-4o-mini" },
  light: { provider: "openai", model: "gpt-4o-mini" },
  local_only: false,
};

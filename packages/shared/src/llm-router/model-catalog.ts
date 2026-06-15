/**
 * Model catalog — PR-Q13, phase-a appendix #9.
 *
 * The LLM-policy editor's model dropdown is populated from
 * this static seed list. Operators pick `provider + model`
 * via two coupled dropdowns instead of hand-typing the JSON
 * shape (`{thinker:{provider:"openrouter",model:"moonshotai/kimi-k2.6"},…}`)
 * the prior textarea forced.
 *
 * Why a static seed list (not a live fetch) for v0.1:
 *  - first-boot UX has to work offline (the operator hasn't
 *    yet entered provider keys when picking the policy);
 *  - dynamic-fetch has provider-specific surfaces — OpenAI's
 *    `/v1/models` returns ~80 models including embeddings, the
 *    operator never wants to see those — list-curation is
 *    needed regardless;
 *  - v0.2 plan: the `GET /api/admin/llm-models` endpoint that
 *    reads this seed is the integration seam where dynamic
 *    fetch slots in without UI churn.
 *
 * Why the typing matters: the `Record<ProviderName, …>` shape
 * is exhaustive against the closed `PROVIDERS` tuple. Adding
 * a sixth provider to `llm-policy.ts` will fail this file's
 * type-check until the catalog is extended — preventing a
 * silently-empty dropdown for the new provider.
 *
 * Why ollama is empty: local Ollama installs run an arbitrary
 * mix of models that the operator pulled themselves
 * (`ollama pull <name>`). The catalog cannot pre-enumerate
 * them; the editor renders a custom-input field for that
 * provider instead. OpenRouter exposes hundreds of models;
 * the editor seeds with the most-used dropdown and ALSO offers
 * "Other model…" → custom-input as a fallback.
 */
import type { ProviderName } from "./llm-policy.js";

/**
 * Most-used 3-6 models per provider as of January 2026.
 * Curated for v0.1 operator choice; not exhaustive.
 *
 * Conventions:
 *  - openai/anthropic/google: provider-namespaced ids the
 *    Vercel AI SDK accepts directly (no provider prefix).
 *  - openrouter: `<owner>/<model>` slugs the OpenRouter API
 *    expects (e.g. `moonshotai/kimi-k2.6`).
 *  - ollama: empty by design (see file header).
 */
export const MODEL_CATALOG: Readonly<
  Record<ProviderName, readonly string[]>
> = {
  openai: [
    "gpt-4o",
    "gpt-4o-mini",
    "o1",
    "o1-mini",
    "gpt-4-turbo",
  ],
  anthropic: [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-3-5-sonnet-20241022",
  ],
  google: [
    "gemini-2.0-flash",
    "gemini-2.0-flash-thinking",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
  ],
  ollama: [],
  openrouter: [
    "moonshotai/kimi-k2.6",
    "anthropic/claude-sonnet-4",
    "anthropic/claude-opus-4-7",
    "openai/gpt-4o",
    "google/gemini-2.0-flash",
    "deepseek/deepseek-r1",
  ],
  // Azure OpenAI: the model id is the *deployment name* on the
  // operator's resource (driven via the `/openai/v1` path with the
  // model in the request body), not a vendor-global slug. Empty by
  // design — like ollama, deployment names are installation-specific
  // and cannot be enumerated in advance; the editor renders a
  // custom-input field for this provider.
  azure: [],
} as const;

/**
 * `GET /api/admin/llm-models` — model catalog endpoint
 * (PR-Q13, phase-a appendix #9).
 *
 * The Management UI's `LlmPolicyEditor` calls this on mount
 * to populate the per-tier model dropdown. Returning the
 * static catalog from `@opencoo/shared/llm-router` keeps
 * server + UI in lockstep — adding a model to a provider's
 * seed list is one shared edit, no UI patch.
 *
 * Why server-mediated (vs. importing the catalog directly
 * in the UI bundle): the endpoint is the integration seam
 * for v0.2's dynamic-fetch lift (per-provider `/v1/models`
 * union plus operator-curated allow-list); slotting that
 * behind an existing route avoids a UI churn cycle later.
 *
 * Read-only — no audit-log row written, no CSRF gate. The
 * admin-API plugin's `verifyAdmin` preHandler already
 * enforces auth; the response carries no per-domain or
 * per-operator data.
 *
 * Response shape:
 *   {
 *     catalog: {
 *       openai: ["gpt-4o", "gpt-4o-mini", ...],
 *       anthropic: [...],
 *       google: [...],
 *       ollama: [],            // empty by design
 *       openrouter: [...],
 *     }
 *   }
 *
 * The empty `ollama` arm is load-bearing: the editor renders
 * a custom-input field for that provider instead of a
 * dropdown.
 */
import type { FastifyInstance } from "fastify";

import {
  MODEL_CATALOG,
  type ProviderName,
} from "@opencoo/shared/llm-router";

export interface RegisterLlmModelsRouteArgs {
  readonly app: FastifyInstance;
  /** @internal Test seam — defaults to the production catalog. */
  readonly catalog?: Readonly<Record<ProviderName, readonly string[]>>;
}

export function registerLlmModelsRoute(args: RegisterLlmModelsRouteArgs): void {
  const catalog = args.catalog ?? MODEL_CATALOG;
  args.app.get("/api/admin/llm-models", async () => {
    return { catalog };
  });
}

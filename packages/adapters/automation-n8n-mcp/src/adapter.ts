/**
 * AutomationAdapter for n8n via the REST API (PR 25 / plan #120).
 *
 * # Gate 3 — runtime layer (THREAT-MODEL §2 invariant 7)
 *
 * The body-build site below is the ONLY place in this package's
 * source where the active-disabled literal appears in adapter
 * code (the Zod schema in n8n-api.ts adds a second occurrence
 * via `z.literal(false)`, which is the belt+suspenders Gate 3
 * check before the REST call leaves the adapter). The test suite
 * source-greps for the literal and asserts an exact count — adding
 * a third occurrence (e.g. an `if (debug) body.active = false`)
 * fails the build.
 *
 * # Gate 3 — type layer (local extension)
 *
 * `N8nLikeApi.createWorkflow` accepts NO `active` parameter on
 * its argument shape. A future PR that adds one fails the
 * type-level pin in the test file.
 *
 * # Error mapping
 *
 *   - 401 / other 4xx  → validation (DLQ; client-side bug)
 *   - 429 + Retry-After → upstream-quota with retryAfterSeconds
 *   - 5xx / network drop → transient
 *
 * # Credential rotation
 *
 * The adapter reads the bearer token from CredentialStore on
 * EVERY deployWorkflow call (no module-level memoization) so a
 * rotated token picks up on the next deploy without an engine
 * restart.
 */
import {
  classifyHttpError,
  type OutputAdapterError,
  type OutputCredentialSchema,
} from "@opencoo/shared/output-adapter";
import type {
  CredentialStore,
} from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import type { Proposal, SkillsUsed } from "@opencoo/shared/db";

import { n8nMcpCredentialSchema } from "./credential-schema.js";
import {
  n8nWorkflowBodySchema,
  type N8nApiError,
  type N8nLikeApi,
  type N8nWorkflowBody,
} from "./n8n-api.js";

export const AUTOMATION_N8N_MCP_SLUG = "n8n-mcp" as const;

/**
 * Args mirror engine-self-operating's `DeployWorkflowArgs`.
 * Re-declared locally so this package does not import from
 * engine-self-operating (open question 5 — adapter package
 * boundary kept clean).
 */
export interface DeployWorkflowArgs {
  readonly templateSlug: string;
  readonly resolvedParams: Proposal["params"];
  readonly skillsUsed: SkillsUsed;
}

export interface DeployWorkflowResult {
  /** n8n's workflow id. The Builder persists this on
   *  automation_deployments.n8n_workflow_id. */
  readonly n8nWorkflowId: string;
}

/** Locally-named adapter shape. Structurally satisfies
 *  `AutomationAdapter` from engine-self-operating — the harness
 *  binds it at the composition root via shape, not nominal
 *  identity, so adding a method here would slip past the engine-
 *  side method-allow-list (the engine's Gate-3 contract test
 *  pins the engine port shape, which is what the harness
 *  consumes). The slug field is package-local metadata. */
export interface AutomationN8nMcpAdapter {
  readonly slug: typeof AUTOMATION_N8N_MCP_SLUG;
  deployWorkflow(args: DeployWorkflowArgs): Promise<DeployWorkflowResult>;
}

export type MakeN8nApi = () => N8nLikeApi;

export interface CreateAutomationN8nMcpAdapterArgs {
  /** CredentialStore — token resolved on every deployWorkflow
   *  call (rotation pin). */
  readonly credentialStore: CredentialStore;
  readonly credentialId: CredentialId;
  /** Base URL of the n8n instance. */
  readonly baseUrl: string;
  /** API factory — production wraps a fetch-based REST client;
   *  tests inject the mock from `./testing/mock-n8n-api.ts`. */
  readonly makeApi: MakeN8nApi;
}

function isN8nApiError(value: unknown): value is N8nApiError {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { kind?: unknown };
  return v.kind === "http" || v.kind === "transient";
}

function mapApiErrorToOutputError(err: unknown): OutputAdapterError {
  if (isN8nApiError(err)) {
    if (err.kind === "http") {
      return classifyHttpError({
        status: err.status,
        retryAfterHeader:
          err.retryAfterSeconds !== undefined
            ? String(err.retryAfterSeconds)
            : null,
        message: `n8n createWorkflow: ${err.message}`,
        cause: err,
      });
    }
    return classifyHttpError({
      status: 503,
      message: `n8n createWorkflow: ${err.message}`,
      cause: err,
    });
  }
  return classifyHttpError({
    status: 503,
    message: `n8n createWorkflow: unknown error (${err instanceof Error ? err.message : String(err)})`,
    cause: err,
  });
}

export function createAutomationN8nMcpAdapter(
  args: CreateAutomationN8nMcpAdapterArgs,
): AutomationN8nMcpAdapter {
  return {
    slug: AUTOMATION_N8N_MCP_SLUG,
    async deployWorkflow(
      deployArgs: DeployWorkflowArgs,
    ): Promise<DeployWorkflowResult> {
      // Resolve credential on every call — rotation pin.
      const credential = await args.credentialStore.read(args.credentialId);
      const bearerToken = credential.plaintext.toString("utf8");

      // ---- Gate 3 body-build site (single occurrence in src) ----
      // The literal below is asserted by the test suite via
      // source-grep. Do NOT duplicate or refactor away.
      const body: N8nWorkflowBody = n8nWorkflowBodySchema.parse({
        name: `opencoo-${deployArgs.templateSlug}`,
        nodes: [],
        connections: {},
        settings: {},
        active: false,
        tags: ["opencoo"],
      });
      // ---- end Gate 3 body-build site ----

      try {
        const result = await args.makeApi().createWorkflow({
          bearerToken,
          baseUrl: args.baseUrl,
          apiVersion: "v1",
          body,
        });
        return { n8nWorkflowId: result.id };
      } catch (err) {
        throw mapApiErrorToOutputError(err);
      }
    },
  };
}

export { n8nMcpCredentialSchema };
export type { OutputCredentialSchema };

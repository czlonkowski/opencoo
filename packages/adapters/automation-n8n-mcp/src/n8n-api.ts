/**
 * Minimal n8n-like REST surface (PR 25 / plan #120).
 *
 * The adapter consumes ONLY this method from an n8n client.
 * Use-case-tier tests inject a mock that fulfills the shape;
 * production wiring (PR 38) wraps a real fetch-based REST
 * client around this interface.
 *
 * # Gate 3 type-level extension (THREAT-MODEL §2 invariant 7)
 *
 * `N8nLikeApi.createWorkflow` accepts NO `active` parameter on
 * its argument shape. The body that ships to n8n is built by
 * the adapter, validated against `n8nWorkflowBodySchema`, and
 * carries the active-disabled literal. Adding an `active`
 * argument here would let a future caller flip the flag without
 * touching the body-build site — a Gate 3 bypass route.
 */
import { z } from "zod";

/**
 * Body the adapter POSTs to `/api/v1/workflows`. Schema is
 * `.passthrough()` for forward-compatibility (n8n adds fields
 * release-to-release) BUT pins `active` to a literal `false` —
 * the Gate 3 belt enforced before the REST call leaves the
 * adapter.
 */
export const n8nWorkflowBodySchema = z
  .object({
    name: z.string().min(1).max(255),
    nodes: z.array(z.unknown()),
    connections: z.record(z.string(), z.unknown()),
    settings: z.record(z.string(), z.unknown()),
    active: z.literal(false),
    tags: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type N8nWorkflowBody = z.infer<typeof n8nWorkflowBodySchema>;

export interface N8nCreateWorkflowArgs {
  /** Bearer token resolved from CredentialStore at deploy time. */
  readonly bearerToken: string;
  /** Base URL of the n8n instance — `https://n8n.example.com`. */
  readonly baseUrl: string;
  /** n8n REST API version. Hardcoded to `v1` in v0.1; reserved
   *  in the credential schema for future migration. */
  readonly apiVersion: "v1";
  /** Pre-validated workflow body. */
  readonly body: N8nWorkflowBody;
}

export interface N8nCreateWorkflowResult {
  /** n8n's workflow id (string). The Builder persists this on
   *  `automation_deployments.n8n_workflow_id`. */
  readonly id: string;
}

/**
 * n8n REST API failure — the production wrapper translates the
 * fetch error into this shape so the adapter's classification
 * keys on a portable structure.
 */
export interface N8nApiHttpError {
  readonly kind: "http";
  readonly status: number;
  readonly retryAfterSeconds?: number;
  readonly message: string;
}

export interface N8nApiTransientError {
  readonly kind: "transient";
  readonly message: string;
}

export type N8nApiError = N8nApiHttpError | N8nApiTransientError;

export interface N8nLikeApi {
  /** POST `/api/{apiVersion}/workflows` with the body — note
   *  there is NO `active` argument on this signature; the body
   *  carries the literal at the body-build site. */
  createWorkflow(args: N8nCreateWorkflowArgs): Promise<N8nCreateWorkflowResult>;
}

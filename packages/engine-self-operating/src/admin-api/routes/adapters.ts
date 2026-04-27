/**
 * `GET /api/admin/adapters` — adapter descriptor list (phase-a
 * appendix #2).
 *
 * The Management UI's "+ New binding" modal picker calls this
 * to populate the adapter dropdown. Returning the same
 * descriptors the binding-create route uses for validation
 * keeps server + UI in lockstep — adding a fifth adapter is
 * one registry edit, no UI patch.
 *
 * Response shape:
 *   {
 *     adapters: [
 *       {
 *         slug: 'drive' | 'asana' | 'n8n' | 'fireflies' | …,
 *         mode: 'polling' | 'webhook',
 *         credentialSchema: { type: 'object', properties: {...} },
 *       },
 *       ...
 *     ]
 *   }
 *
 * Read-only — no audit-log row written; the admin-API plugin's
 * `verifyAdmin` preHandler enforces the auth gate.
 */
import type { FastifyInstance } from "fastify";

import {
  SOURCE_ADAPTER_CREDENTIAL_SCHEMAS,
  type SourceAdapterCredentialDescriptor,
  type SourceAdapterSlug,
} from "@opencoo/shared/source-adapter";

export interface AdapterListEntry {
  readonly slug: SourceAdapterSlug;
  readonly mode: SourceAdapterCredentialDescriptor["mode"];
  readonly credentialSchema: SourceAdapterCredentialDescriptor["credentialSchema"];
}

export interface RegisterAdaptersRouteArgs {
  readonly app: FastifyInstance;
  /** @internal Test seam — defaults to the production registry. */
  readonly registry?: Readonly<
    Record<SourceAdapterSlug, SourceAdapterCredentialDescriptor>
  >;
}

export function registerAdaptersRoute(args: RegisterAdaptersRouteArgs): void {
  const registry = args.registry ?? SOURCE_ADAPTER_CREDENTIAL_SCHEMAS;
  args.app.get("/api/admin/adapters", async () => {
    const adapters: AdapterListEntry[] = (Object.keys(registry) as SourceAdapterSlug[])
      .sort()
      .map((slug) => ({
        slug,
        mode: registry[slug].mode,
        credentialSchema: registry[slug].credentialSchema,
      }));
    return { adapters };
  });
}

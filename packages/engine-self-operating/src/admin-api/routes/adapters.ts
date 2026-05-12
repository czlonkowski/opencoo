/**
 * `GET /api/admin/adapters` — adapter descriptor list (phase-a
 * appendix #2; PR-Q9 adds `bindingConfigSchema`; PR-Z4 adds
 * `outputAdapters` for the Outputs tab "+ New channel" modal).
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
 *         bindingConfigSchema: { type: 'object', properties: {...},
 *                                required: [...] },
 *       },
 *       ...
 *     ],
 *     // PR-Z4 (phase-a appendix #12 G5) — alongside the source
 *     // adapters, the OutputAdapter descriptors the new
 *     // `+ New output channel` modal uses to render the form.
 *     outputAdapters: [
 *       {
 *         slug: 'asana' | …,
 *         credentialSchema: { type: 'object', properties: {...} },
 *         channelConfigSchema: { type: 'object', properties: {...} },
 *       },
 *       ...
 *     ]
 *   }
 *
 * `bindingConfigSchema` powers the third wizard step ("operational
 * settings"): without it, the modal posted an empty `config: {}`
 * and Asana bindings 500'd at `factory_threw` on the first
 * webhook delivery (the adapter's Zod schema requires `projectGid`).
 * Surfacing the schema here lets the form prompt for it up-front
 * and the route validate it BEFORE the INSERT.
 *
 * Read-only — no audit-log row written; the admin-API plugin's
 * `verifyAdmin` preHandler enforces the auth gate.
 */
import type { FastifyInstance } from "fastify";

import {
  SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS,
  SOURCE_ADAPTER_CREDENTIAL_SCHEMAS,
  SOURCE_ADAPTER_DEFAULT_ALLOWED_PATHS,
  type BindingConfigSchema,
  type SourceAdapterCredentialDescriptor,
  type SourceAdapterSlug,
} from "@opencoo/shared/source-adapter";

import {
  getOutputAdapterListEntries,
  type OutputAdapterDescriptor,
  type OutputAdapterListEntry,
  type OutputAdapterSlug,
} from "./output-channels.js";

export interface AdapterListEntry {
  readonly slug: SourceAdapterSlug;
  readonly mode: SourceAdapterCredentialDescriptor["mode"];
  readonly credentialSchema: SourceAdapterCredentialDescriptor["credentialSchema"];
  readonly bindingConfigSchema: BindingConfigSchema;
  /** PR-W1 (phase-a appendix #14) — per-adapter `allowed_paths`
   *  suggestions surfaced as click-to-add chips in the
   *  `+ New binding` wizard's 4th step. Operators can replace or
   *  extend the list freely; the runtime classifier guard
   *  (`assertBindingNotWildcardOnly`) remains the security
   *  boundary. Drift-checked against the adapter packages'
   *  `DEFAULT_ALLOWED_PATHS` constants. */
  readonly defaultAllowedPaths: readonly string[];
}

export interface RegisterAdaptersRouteArgs {
  readonly app: FastifyInstance;
  /** @internal Test seam — defaults to the production registry. */
  readonly registry?: Readonly<
    Record<SourceAdapterSlug, SourceAdapterCredentialDescriptor>
  >;
  /** @internal Test seam — defaults to the production binding-config registry. */
  readonly bindingConfigRegistry?: Readonly<
    Record<SourceAdapterSlug, BindingConfigSchema>
  >;
  /** @internal Test seam — defaults to the production
   *  default-allowed-paths registry (PR-W1). */
  readonly defaultAllowedPathsRegistry?: Readonly<
    Record<SourceAdapterSlug, readonly string[]>
  >;
  /** PR-Z4 — output-adapter registry. Defaults to a lazy import
   *  of `@opencoo/output-asana`; tests pass a stub via the
   *  admin-API plugin's `outputChannelRegistry` field. */
  readonly outputAdapterRegistry?: Readonly<
    Record<OutputAdapterSlug, OutputAdapterDescriptor>
  >;
}

export function registerAdaptersRoute(args: RegisterAdaptersRouteArgs): void {
  const registry = args.registry ?? SOURCE_ADAPTER_CREDENTIAL_SCHEMAS;
  const bindingConfigRegistry =
    args.bindingConfigRegistry ?? SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS;
  const defaultAllowedPathsRegistry =
    args.defaultAllowedPathsRegistry ?? SOURCE_ADAPTER_DEFAULT_ALLOWED_PATHS;
  args.app.get("/api/admin/adapters", async () => {
    const adapters: AdapterListEntry[] = (Object.keys(registry) as SourceAdapterSlug[])
      .sort()
      .map((slug) => ({
        slug,
        mode: registry[slug].mode,
        credentialSchema: registry[slug].credentialSchema,
        bindingConfigSchema: bindingConfigRegistry[slug],
        defaultAllowedPaths: defaultAllowedPathsRegistry[slug],
      }));
    const outputAdapters: readonly OutputAdapterListEntry[] =
      getOutputAdapterListEntries(args.outputAdapterRegistry);
    return { adapters, outputAdapters };
  });
}

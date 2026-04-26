/**
 * Cross-engine adapter registry contract (PR 30 / plan #135).
 *
 * Both engines + the CLI need to map `sources_bindings.adapter_slug`
 * → the right adapter factory. This module owns the CONTRACT (the
 * `AdapterRegistry` interface, the `SourceAdapterSlug` enum, and
 * the factory shape every adapter package's `create*Adapter`
 * function satisfies).
 *
 * The CONCRETE registry that imports each adapter package is
 * built per consumer (engine-ingestion, engine-self-operating,
 * CLI). v0.1 keeps the wiring simple: each consumer constructs
 * its own registry instance via `buildAdapterRegistry({ ... })`,
 * passing the adapter factories it needs. Shared owns the
 * interface so the consumers stay in sync.
 *
 * Per planner Q10 OVERRIDE: this file lives in
 * `@opencoo/shared/adapter-registry/` rather than under any
 * engine-* path. Putting it under engine-self-operating would
 * force engine-ingestion to import across the engine boundary
 * (no-cross-engine-import) AND would create a circular
 * dependency (shared ↛ engines, but engines → shared). Shared
 * is the canonical home for the contract; the CONSUMERS supply
 * their own factory wirings.
 */
import type { CredentialStore } from "../credential-store/index.js";
import type { CredentialId } from "../db/brands.js";
import type { SourceAdapter } from "../source-adapter/index.js";

/** v0.1 SourceAdapter slugs, mirroring `sources_bindings.adapter_slug`
 *  in the four shipped packages: drive / asana / n8n / fireflies.
 *  Output + Automation adapters live in their own packages and
 *  are NOT registered here — `source test` operates only on
 *  SourceAdapter bindings. */
export const SOURCE_ADAPTER_SLUGS = [
  "drive",
  "asana",
  "n8n",
  "fireflies",
] as const;

export type SourceAdapterSlug = (typeof SOURCE_ADAPTER_SLUGS)[number];

/**
 * Args every adapter factory accepts. `config` is the persisted
 * JSON blob from `sources_bindings.config`; the adapter's
 * binding-config Zod schema parses it inside the factory. For
 * webhook-mode adapters (asana, fireflies) the factory still
 * takes `(credentialStore, credentialId)` — the webhook
 * receiver resolves the per-binding webhook secret via
 * `config.webhookSecretCredentialId` separately.
 *
 * `extras` is a free-form per-adapter overrides bag — production
 * wirings (drive's `makeDrive`, n8n's `makeApi`) thread their
 * client constructors through here without bloating this
 * shared interface with adapter-specific fields. The consumer
 * registry knows what each adapter needs.
 */
export interface AdapterFactoryArgs {
  readonly credentialStore: CredentialStore;
  readonly credentialId: CredentialId;
  readonly config: unknown;
  readonly extras?: Readonly<Record<string, unknown>>;
}

export type SourceAdapterFactory = (
  args: AdapterFactoryArgs,
) => SourceAdapter;

/**
 * Registry map. Built per-consumer with the factories the
 * consumer actually needs. The CLI's `source test` verb gets a
 * registry seeded with all four; an engine that ships a
 * narrower set (e.g. an air-gapped deploy with only Drive +
 * Asana) seeds only those slugs and gets a clean
 * "adapter not registered" error for any other.
 */
export interface AdapterRegistry {
  /** Stable list of slugs the registry can resolve. Iteration
   *  order is insertion order. */
  readonly slugs: ReadonlyArray<SourceAdapterSlug>;
  /** Resolve a slug to its factory. Returns `undefined` for
   *  unknown slugs — callers translate to a typed error. */
  readonly resolve: (
    slug: SourceAdapterSlug,
  ) => SourceAdapterFactory | undefined;
}

export interface BuildAdapterRegistryArgs {
  readonly factories: Readonly<
    Partial<Record<SourceAdapterSlug, SourceAdapterFactory>>
  >;
}

/**
 * Build a registry from a slug → factory map. Order is the
 * iteration order of the input map's keys (preserved by
 * `Object.keys` for string keys). Adapter packages are imported
 * by the CALLER, not here, so this module never pulls a
 * production-only adapter dep.
 */
export function buildAdapterRegistry(
  args: BuildAdapterRegistryArgs,
): AdapterRegistry {
  const inputSlugs = Object.keys(args.factories) as SourceAdapterSlug[];
  const slugs: SourceAdapterSlug[] = inputSlugs.filter((s) =>
    (SOURCE_ADAPTER_SLUGS as readonly string[]).includes(s),
  );
  const resolve = (slug: SourceAdapterSlug): SourceAdapterFactory | undefined =>
    args.factories[slug];
  return { slugs, resolve };
}

/**
 * Typed error thrown by callers when `resolve(slug)` returns
 * `undefined` — keeps the not-registered case explicit at the
 * call site rather than silently no-op.
 */
export class AdapterNotRegisteredError extends Error {
  readonly slug: string;
  constructor(slug: string) {
    super(`adapter '${slug}' is not registered in this engine's registry`);
    this.name = "AdapterNotRegisteredError";
    this.slug = slug;
  }
}

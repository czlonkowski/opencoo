/**
 * Per-adapter default `allowed_paths` suggestions (PR-W1 of phase-a
 * appendix #14).
 *
 * Sister registry to `credential-schemas.ts` and
 * `binding-config-schemas.ts`. Each wired SourceAdapter declares the
 * subtree-glob patterns that are the sensible v0.1 default for that
 * source — the Management UI's `+ New binding` wizard renders these
 * as click-to-add chips in the new "Allowed wiki paths" step, the
 * bootstrap scripts seed them on partner-fixture bindings, and the
 * runtime classifier guard (`assertBindingNotWildcardOnly` in
 * `engine-ingestion/src/classifier/binding-guard.ts`) accepts them
 * verbatim.
 *
 * These are SUGGESTIONS, not enforcement — operators can replace or
 * extend the list freely in the wizard. The runtime guard remains the
 * security boundary; the registry just keeps fresh deployments from
 * landing on the `'{}'::text[]` schema default and failing every
 * compile job (the symptom that triggered wave-14).
 *
 * Pattern rules (mirrors the runtime guard):
 *   - Empty list is rejected by the guard. The registry returns a
 *     non-empty array per slug.
 *   - Bare `**` and `**\/foo` shapes are rejected by the guard.
 *   - Bounded subtree globs like `meetings/\*\*` are accepted
 *     (the runtime accept-set: any pattern with a non-empty
 *     prefix before the globstar).
 *
 * Drift prevention: each adapter package re-exports a
 * `DEFAULT_ALLOWED_PATHS` constant and ships a vitest case asserting
 * its value matches `getDefaultAllowedPaths(<slug>)`. The shared
 * module remains authoritative for the GET /api/admin/adapters
 * surface; the adapter export keeps the value reachable via the
 * existing adapter import path (matches the `bindingConfigSchema`
 * pattern).
 */
import type { SourceAdapterSlug } from "./credential-schemas.js";

/**
 * Frozen registry — readonly tuple shape so a downstream caller
 * can't mutate the suggestions out from under another caller in the
 * same process. Keys MUST stay in sync with `SourceAdapterSlug`; the
 * `Record<SourceAdapterSlug, …>` type forces a TypeScript error if
 * a new slug is added to `credential-schemas.ts` without a
 * corresponding default-paths entry.
 */
export const SOURCE_ADAPTER_DEFAULT_ALLOWED_PATHS: Readonly<
  Record<SourceAdapterSlug, readonly string[]>
> = {
  drive: ["meetings/**", "transcripts/**", "docs/**"],
  asana: ["projects/**", "tasks/**"],
  fireflies: ["meetings/**"],
  n8n: ["workflows/**"],
  // `webhook` is the generic inbound webhook adapter — operators
  // configure the path segment per binding, so a `webhook/**`
  // subtree is the sensible default. Keeps the registry exhaustive
  // (TypeScript blocks an omitted slug).
  webhook: ["webhook/**"],
  // `okf` mirrors each concept to its bundle path verbatim, so
  // allowed_paths is ADVISORY for okf-bundle bindings (the compile
  // path does not gate on it). Bounded + non-wildcard so it passes the
  // create-time guard; operators replace it per bundle layout.
  okf: ["okf/**"],
} as const;

/** Type-narrowing helper. Returns `undefined` for unknown slugs
 *  rather than throwing — matches the `getSourceAdapterDescriptor`
 *  shape so callers can pattern-match on absence the same way. */
export function getDefaultAllowedPaths(
  slug: string,
): readonly string[] | undefined {
  return (
    SOURCE_ADAPTER_DEFAULT_ALLOWED_PATHS as Record<string, readonly string[]>
  )[slug];
}

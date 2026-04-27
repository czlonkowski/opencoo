/**
 * Default `review_mode` policy for new source-bindings (
 * architecture.md §307 per-domain-class table + §364
 * transcription override).
 *
 * Single source of truth shared by:
 *   - the Management UI "+ New binding" modal prefill, so the
 *     server and the UI agree without round-trips,
 *   - the `POST /api/admin/source-bindings` route's default
 *     when the operator omits `review_mode`.
 *
 * The operator may override at create time. This helper returns
 * the *default* the form/route SHOULD apply, not a constraint.
 *
 * v0.1 only emits `auto` or `approve` — `review` (rich inline
 * edit) is parked for v2+ across all classes (§315).
 */

/** Domain classes from `domains.class` enum (`enums.ts`). */
export type DomainClass = "knowledge" | "catalog-workflows" | "catalog-skills";

/** v0.1 review-mode literals — same set as the
 *  `review_mode` Postgres enum. `review` is reserved for v2+. */
export type ReviewModeDefault = "auto" | "approve";

/**
 * Adapter slugs whose source content is *transcription* (per
 * architecture.md §364: "the softest attack surface — anyone on
 * a recorded call can say anything"). Override domain-class
 * default to `approve`.
 *
 * Currently only fireflies, but the set is exported so future
 * transcription adapters (otter, fathom, gong, …) opt into the
 * override by adding their slug here, NOT by patching the
 * route handler. Keeps the policy in one named place.
 */
export const TRANSCRIPTION_ADAPTER_SLUGS = ["fireflies"] as const satisfies readonly string[];

export interface DefaultReviewModeArgs {
  readonly adapterSlug: string;
  readonly domainClass: DomainClass;
}

/**
 * Resolve the default `review_mode` for a (adapter, domain-class)
 * pair.
 *
 * Order of precedence:
 *   1. Transcription adapter → `approve` (regardless of class).
 *   2. `catalog-skills` class → `approve` (quarterly human gate).
 *   3. Anything else → `auto`.
 */
export function defaultReviewModeFor(
  args: DefaultReviewModeArgs,
): ReviewModeDefault {
  if ((TRANSCRIPTION_ADAPTER_SLUGS as readonly string[]).includes(args.adapterSlug)) {
    return "approve";
  }
  if (args.domainClass === "catalog-skills") {
    return "approve";
  }
  return "auto";
}

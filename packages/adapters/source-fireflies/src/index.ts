/**
 * Public surface for `@opencoo/source-fireflies` (PR 27 / plan
 * #126).
 *
 * Webhook-mode SourceAdapter for Fireflies meeting transcripts.
 * Production wiring (PR 30 composition root) wires the
 * engine-ingestion webhook receiver to consume the adapter's
 * `webhook` helpers.
 */
export {
  FIREFLIES_ADAPTER_SLUG,
  FIREFLIES_SIGNATURE_HEADER,
  buildFirefliesWebhookHelpers,
  createFirefliesSourceAdapter,
  extractFirefliesSignature,
  extractFirefliesWebhookSecret,
  wrapFirefliesWebhookSecret,
  firefliesBindingConfigSchema,
  type BuildFirefliesWebhookHelpersArgs,
  type CreateFirefliesSourceAdapterArgs,
  type FirefliesBindingConfig,
} from "./adapter.js";

/**
 * PR-W1 (phase-a appendix #14) — per-adapter `allowed_paths`
 * suggestions surfaced as click-to-add chips in the Management
 * UI's `+ New binding` wizard. Drift-checked against the
 * authoritative registry in `@opencoo/shared/source-adapter`.
 */
export const DEFAULT_ALLOWED_PATHS = [
  "meetings/**",
] as const satisfies readonly string[];

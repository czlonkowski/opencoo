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

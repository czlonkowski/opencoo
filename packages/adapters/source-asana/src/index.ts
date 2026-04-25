/**
 * Public surface for `@opencoo/source-asana` (PR 24 / plan #115).
 *
 * Webhook-mode SourceAdapter for Asana. Production wiring
 * (PR 30 composition root) wires the engine-ingestion webhook
 * receiver to consume the adapter's `webhook` helpers.
 */
export {
  asanaBindingConfigSchema,
  type AsanaBindingConfig,
} from "./binding-config.js";

export {
  ASANA_ADAPTER_SLUG,
  ASANA_SIGNATURE_HEADER,
  buildAsanaWebhookHelpers,
  createAsanaSourceAdapter,
  extractAsanaSignature,
  type CreateAsanaSourceAdapterArgs,
} from "./adapter.js";

/**
 * Public surface for `@opencoo/source-webhook` (PR-I /
 * phase-a appendix #4).
 *
 * Generic webhook-mode SourceAdapter. Accepts HMAC-signed inbound
 * webhooks from any sender; maps payload fields to content_kind via
 * per-binding jsonpath configuration. Production wiring (engine-ingestion
 * composition root) wires this adapter's webhook helpers into the
 * receiver for any binding with adapter_slug='webhook'.
 *
 * THREAT-MODEL coverage in this package:
 *   - §3.1 HMAC + replay: HmacSha256Verifier + deterministic event_id
 *   - §3.7 review-mode default: 'review' for all new bindings
 *   - §3.6 invariant 11: no signing-secret bytes in errors
 */
export {
  sourceWebhookBindingConfigSchema,
  type SourceWebhookBindingConfig,
} from "./binding-config.js";

export {
  WEBHOOK_ADAPTER_SLUG,
  WEBHOOK_SIGNATURE_HEADER,
  buildWebhookHelpers,
  createSourceWebhookAdapter,
  extractWebhookSignature,
  type BuildWebhookHelpersOptions,
  type CreateSourceWebhookAdapterArgs,
} from "./adapter.js";

export {
  deriveEventId,
  extractJsonPath,
} from "./event-id-derivation.js";

export {
  resolveContentKind,
} from "./content-kind-mapping.js";

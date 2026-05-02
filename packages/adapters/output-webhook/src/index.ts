/**
 * Public surface for `@opencoo/output-webhook` (PR-J / phase-a appendix #4).
 *
 * Generic webhook OutputAdapter — delivers opencoo payloads to any
 * external HTTP receiver with HMAC signing, exponential-backoff retry,
 * and append-only `output_deliveries` audit.
 */
export {
  WEBHOOK_OUTPUT_ADAPTER_SLUG,
  createWebhookOutputAdapter,
  webhookOutputCredentialSchema,
  type CreateWebhookOutputAdapterArgs,
  type FetchFn,
} from "./adapter.js";

export {
  webhookOutputBindingConfigSchema,
  type RetryPolicy,
  type WebhookOutputBindingConfig,
} from "./binding-config.js";

export {
  noOpDeliveryWriter,
  type OutputDeliveryRow,
  type OutputDeliveryStatus,
  type OutputDeliveryWriter,
} from "./output-deliveries-writer.js";

export {
  webhookPayloadSchema,
  type WebhookPayload,
} from "./payload-schema.js";

export { computeHmac, deriveDeliveryId } from "./signing.js";

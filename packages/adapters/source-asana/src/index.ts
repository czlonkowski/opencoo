/**
 * Public surface for `@opencoo/source-asana` (PR 24 / plan #115;
 * extended in PR-F: handshake + event_type derivation +
 * monitored-project filter + Light per-event summary).
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
  ASANA_HOOK_SECRET_HEADER,
  ASANA_SIGNATURE_HEADER,
  buildAsanaWebhookHelpers,
  buildSnapshotEvent,
  createAsanaSourceAdapter,
  extractAsanaSignature,
  extractAsanaWebhookSecret,
  wrapAsanaWebhookSecret,
  type BuildAsanaWebhookHelpersOptions,
  type CreateAsanaSourceAdapterArgs,
} from "./adapter.js";

export {
  createAsanaClient,
  DEFAULT_OPT_FIELDS,
  type AsanaClient,
  type AsanaClientArgs,
  type AsanaTaskRow,
  type ProjectSnapshot,
} from "./asana-client.js";

export {
  deriveEventType,
  type EventType,
  type PartialAsanaEvent,
} from "./derive-event-type.js";

export {
  summarizeAsanaEvent,
  type LightSummaryRouter,
  type SummarizeAsanaEventArgs,
} from "./light-summary.js";

export {
  ASANA_SEED_CURSOR_PREFIX,
  runAsanaSeed,
  type RunAsanaSeedArgs,
} from "./seed.js";

/**
 * PR-W1 (phase-a appendix #14) — per-adapter `allowed_paths`
 * suggestions surfaced as click-to-add chips in the Management
 * UI's `+ New binding` wizard. Drift-checked against the
 * authoritative registry in `@opencoo/shared/source-adapter`.
 */
export const DEFAULT_ALLOWED_PATHS = [
  "projects/**",
  "tasks/**",
] as const satisfies readonly string[];

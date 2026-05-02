/**
 * Binding-config schema for the Asana SourceAdapter (PR 24 /
 * plan #115; extended in PR-F).
 *
 * Asana is webhook-mode — the engine-ingestion receiver
 * (PR 14) accepts inbound `POST /webhooks/asana` requests,
 * resolves the binding by webhook target URL or path id, and
 * uses the adapter's `webhook.verifier` + helpers to process
 * the event. The webhook setup handshake (`X-Hook-Secret`
 * echo on first registration) is now implemented in PR-F.
 */
import { z } from "zod";

import { DEFAULT_OPT_FIELDS } from "./asana-client.js";

/** Snapshot acquisition mode for Asana project state (PR-G).
 *
 *  - `'on-event'`  (default): after each qualifying webhook event,
 *    the adapter immediately fetches a fresh project snapshot and
 *    emits it as a second SourceEvent with content_kind='asana-project'.
 *    TODO(PR-H): register 'asana-project' in CONTENT_KINDS const.
 *  - `'periodic'`  : snapshot fetches happen on the Scanner cadence
 *    (scan() is implemented for this mode). No per-event fetches.
 *  - `'off'`       : no snapshot fetches. Only raw webhook events
 *    are emitted. */
const snapshotModeSchema = z.enum(["on-event", "periodic", "off"]).default("on-event");

export const asanaBindingConfigSchema = z
  .object({
    /** Asana project gid the adapter watches. The receiver
     *  matches inbound events against this. */
    projectGid: z.string().min(1),
    /** Optional workspace gid for cross-checks. The PoC keys
     *  the project-to-workspace mapping in a separate table;
     *  v0.1 carries it on the binding for symmetric audit. */
    workspaceGid: z.string().min(1).optional(),
    /** Reference to the webhook secret persisted in the
     *  CredentialStore. The receiver fetches the actual bytes
     *  via this reference at verify-time.
     *
     *  Optional at binding creation time: the first Asana POST
     *  triggers the X-Hook-Secret handshake which writes the
     *  credential and backfills this field automatically via
     *  sources_bindings.webhook_secret_credentials_id. Operators
     *  creating a new binding may omit this; subsequent normal
     *  event POSTs will use the backfilled value. */
    webhookSecretCredentialId: z.string().min(1).optional(),
    /** Operator review mode. Default `auto` — the engine
     *  ingests Asana events without per-doc review. NOTE:
     *  `auto` requires the redaction guard (PR 12) wired into
     *  the ingestion path (untrusted Asana task bodies can
     *  carry adversarial content). */
    reviewMode: z.enum(["auto", "review"]).default("auto"),
    /** Optional allowlist of Asana project GIDs to monitor.
     *  When set, events for projects NOT in this list are
     *  silently dropped before reaching intake. Default
     *  `undefined` = all projects pass (backwards-compat).
     *  In practice every production binding should set this to
     *  a single project gid for deterministic monitoring.
     *
     *  Must contain at least one GID when provided — an empty
     *  array would silently drop all events, which is almost
     *  certainly an operator misconfiguration. The schema
     *  rejects `[]` at parse time to surface the error early. */
    monitoredProjectGids: z.array(z.string().min(1)).min(1).optional(),
    /** When true, each qualifying event gets a Light-tier LLM
     *  call to produce a ≤25-word Polish one-liner summary
     *  persisted as `metadata.summary` on the SourceEvent.
     *  Default false (opt-in to avoid unexpected LLM cost on
     *  high-volume projects).
     *
     *  PR-G wires this in enrichEvents: when snapshotMode='on-event'
     *  and lightSummaryEnabled=true, the summarizeAsanaEvent helper
     *  is called per-event before the snapshot fetch. Requires
     *  llmRouter and domainId to be supplied to the adapter factory. */
    lightSummaryEnabled: z.boolean().default(false),
    /** Snapshot acquisition mode. See `snapshotModeSchema` above. */
    snapshotMode: snapshotModeSchema,
    /** Fields to fetch per task. Defaults to the PoC's six fields:
     *  name, assignee.name, completed, due_on, modified_at,
     *  memberships.section.name. Operators may override per binding
     *  to add custom fields (e.g. custom_fields.{gid}.display_value). */
    optFields: z.array(z.string()).default(() => [...DEFAULT_OPT_FIELDS]),
  })
  .strict();

export type AsanaBindingConfig = z.infer<typeof asanaBindingConfigSchema>;

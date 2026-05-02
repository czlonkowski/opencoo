/**
 * Binding-config schema for the generic webhook SourceAdapter (PR-I).
 *
 * The adapter is configured per-binding. Each binding:
 *   - Listens on `/webhooks/<binding_id>` (the receiver routes by binding_id;
 *     `pathSegment` is a human-readable label stored on the binding row for
 *     the UI — it is NOT part of the URL in v0.1).
 *   - Verifies every inbound POST with HMAC-SHA256 using the secret stored
 *     under `signingSecretCredentialId` in the CredentialStore.
 *   - Extracts the event_id from the payload via `eventIdField` jsonpath —
 *     this is the replay-safety anchor (UNIQUE on webhook_events).
 *   - Routes the event to a content_kind via `contentKindMap` (jsonpath →
 *     CONTENT_KIND presence checks, first match wins) or `defaultContentKind`
 *     when no map is configured.
 *
 * THREAT-MODEL §3.7 — reviewMode defaults to 'review'. New bindings
 * created with this adapter land in the operator's Review Dashboard for
 * explicit approval before any data flows through. The operator must
 * explicitly set `reviewMode: 'auto'` after manual sanity-check.
 *
 * THREAT-MODEL §3.6 invariant 11 — signingSecretCredentialId is a
 * vault reference, never the raw secret bytes.
 */
import { z } from "zod";

import { CONTENT_KINDS } from "@opencoo/shared/db";

export const sourceWebhookBindingConfigSchema = z
  .object({
    /**
     * Human-readable URL segment label for this binding. Used by the
     * management UI to display the binding's webhook endpoint.
     * The actual receiver URL is `/webhooks/<binding_id>` (binding_id is the
     * row UUID from sources_bindings); pathSegment is metadata only.
     */
    pathSegment: z.string().min(1),

    /**
     * Reference to the HMAC signing secret in the CredentialStore.
     * Must be a UUID (the credential's ID, not the raw secret bytes).
     *
     * THREAT-MODEL §3.6 invariant 11: credentials referenced by vault ID,
     * never by value.
     */
    signingSecretCredentialId: z.string().uuid(),

    /**
     * Jsonpath expression to extract the event_id from the payload.
     * Must resolve to a string or number scalar; extraction failure
     * throws ValidationError (fail-closed for replay safety).
     *
     * Examples:
     *   - `$.event.id`           — top-level event object with an id
     *   - `$.payload.event_id`   — nested event_id field
     *   - `$.id`                 — root-level id field
     *
     * THREAT-MODEL §3.1: deterministic event_id is required for the
     * `webhook_events` UNIQUE (binding_id, event_id) replay-dedup constraint.
     */
    eventIdField: z.string().min(1),

    /**
     * Optional mapping of jsonpath → CONTENT_KIND for multi-shape bindings.
     * Keys are jsonpath expressions (field presence check); the first key
     * whose path extracts a non-undefined value from the payload is used.
     *
     * Example: one n8n flow that POSTs both workflow snapshots and
     * campaign events to the same webhook URL:
     * ```json
     * {
     *   "$.workflow": "n8n-workflow",
     *   "$.transcript": "document"
     * }
     * ```
     * When no entry matches, `defaultContentKind` is used.
     */
    contentKindMap: z.record(z.string(), z.string()).optional(),

    /**
     * Fallback content_kind when `contentKindMap` is absent or no entry
     * matches. Defaults to `'webhook-event'` — the generic thin wrapper.
     */
    defaultContentKind: z
      .enum([...CONTENT_KINDS] as [string, ...string[]])
      .default("webhook-event"),

    /**
     * Operator review mode.
     *
     * THREAT-MODEL §3.7: defaults to `'review'` for any new binding —
     * untrusted external systems land in the Review Dashboard for manual
     * operator sanity-check before data flows to the Compiler. The operator
     * must explicitly set `'auto'` after reviewing.
     *
     * Contrast with source-asana, which defaults to `'auto'` because the
     * PoC validates the data quality before pilot cutover. The generic
     * webhook adapter has no such prior validation, so `'review'` is the
     * load-bearing safety default here.
     */
    reviewMode: z.enum(["auto", "review"]).default("review"),
  })
  .strict();

export type SourceWebhookBindingConfig = z.infer<
  typeof sourceWebhookBindingConfigSchema
>;

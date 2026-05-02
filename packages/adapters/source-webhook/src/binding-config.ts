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
 *     the derived value flows into `sourceDocId` + `sourceRevision` on the
 *     ingested document, which the intake layer dedupes via its
 *     `(binding_id, source_doc_id, source_revision)` UNIQUE constraint.
 *   - Routes the event to a content_kind via `contentKindMap` (jsonpath →
 *     CONTENT_KIND presence checks, first match wins) or `defaultContentKind`
 *     when no map is configured.
 *
 * THREAT-MODEL §3.7 — reviewMode defaults to 'review'. New bindings
 * created with this adapter land in the operator's Review Dashboard for
 * explicit approval before any data flows through. The operator must
 * explicitly set `reviewMode: 'auto'` after manual sanity-check.
 *
 * THREAT-MODEL §3.6 invariant 11 — the signing secret is resolved from
 * `binding.credentialsId` at verify-time (NOT from the deprecated
 * `signingSecretCredentialId` config field). Never raw secret bytes.
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
     * @deprecated — Dead field. The receiver resolves the HMAC signing
     * secret from `binding.credentialsId` (the `sources_bindings` row's
     * `credentials_id` column, set when the binding is created via
     * `POST /api/admin/source-bindings`). This config-level UUID is
     * NEVER read at verify-time and exists only for forward-compat with
     * any operator config that already has it set.
     *
     * The signing secret lives in the `webhook_secret` half of the
     * credential pair (see credential-schemas.ts `webhookDescriptor`).
     * Operators do not need to supply this field — the admin API wires
     * the correct `credentials_id` automatically on binding creation.
     *
     * This field will be removed in v0.2 once all existing bindings have
     * been migrated. Until then it is accepted but ignored.
     *
     * THREAT-MODEL §3.6 invariant 11: vault reference, never raw bytes.
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
     * THREAT-MODEL §3.1: deterministic event_id is required for replay
     * safety. The derived value becomes `sourceDocId` + `sourceRevision`
     * on the ingested document; the intake layer dedupes at
     * `(binding_id, source_doc_id, source_revision)` UNIQUE — not at the
     * `webhook_events` table level.
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
     * matches. Defaults to `'document'` — the well-supported two-pass
     * classify→compile path that has a Compiler template in v0.1.
     *
     * Note: `'webhook-event'` is a valid CONTENT_KINDS member and can be
     * set explicitly, but there is no Compiler template for it in v0.1.
     * Operators wanting custom routing use `contentKindMap` to map
     * individual payloads to kinds that DO have templates (e.g.
     * `'document'`, `'n8n-workflow'`).
     *
     * Mirrors the `z.enum(CONTENT_KINDS).default(...)` pattern used in
     * source-drive and source-n8n; the resulting type is `ContentKind`.
     */
    defaultContentKind: z.enum(CONTENT_KINDS).default("document"),

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

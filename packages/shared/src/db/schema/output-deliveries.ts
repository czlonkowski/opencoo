import { integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId } from "./columns.js";

/**
 * Delivery status enum for `output_deliveries`.
 *
 * Values are fixed at INSERT time — no UPDATE after insert
 * (THREAT-MODEL §2 invariant 8, append-only).
 *
 *   success           — 2xx received; delivery confirmed.
 *   transient_failure — 5xx / network drop; retried.
 *   dlq               — terminal failure (all attempts exhausted,
 *                       or non-retryable error class).
 */
export const outputDeliveryStatus = pgEnum("output_delivery_status", [
  "success",
  "transient_failure",
  "dlq",
]);

/**
 * Append-only audit table for output-webhook delivery attempts.
 *
 * Strategy: INSERT per attempt (spec option a). Each retry creates a
 * new row with a fixed status. No UPDATE on prior rows.
 *
 * The natural key is (output_binding_id, delivery_id, attempt) — the
 * UNIQUE constraint prevents double-writes for the same attempt.
 *
 * APPEND-ONLY per THREAT-MODEL §2 invariant 8.
 *
 * NOTE: `output_binding_id` is stored as text (not a FK) in v0.1
 * because the `output_bindings` table will be created in a later PR.
 * The column is a stable identifier (CredentialId or binding UUID)
 * allowing retrospective FK creation without migration complexity.
 */
export const outputDeliveries = pgTable(
  "output_deliveries",
  {
    id: primaryKeyId(),
    /** Identifies the output binding that triggered this delivery.
     *  Stored as text in v0.1 — FK to output_bindings added when
     *  that table lands. */
    outputBindingId: text("output_binding_id").notNull(),
    /** Deterministic UUID v5 derived from (bindingId, payloadHash).
     *  All attempts for the same logical delivery share this id.
     *  Used by receivers for idempotency deduplication.
     *  Typed as `uuid` for DB-level format enforcement and smaller storage. */
    deliveryId: uuid("delivery_id").notNull(),
    /** Zero-based attempt counter. First attempt = 0. */
    attempt: integer("attempt").notNull(),
    /** Fixed at insert time — never updated. */
    status: outputDeliveryStatus("status").notNull(),
    /** HTTP status code returned by the upstream receiver.
     *  NULL on network-level failures (no HTTP response). */
    statusCode: integer("status_code"),
    /** First 500 chars of the receiver's response body.
     *  NULL when no response body or network failure.
     *  NEVER includes credential bytes. */
    responseBodyExcerpt: text("response_body_excerpt"),
    /** When the HTTP request was dispatched. */
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    /** When the attempt completed (response or error). */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("output_deliveries_binding_delivery_attempt_unique").on(
      t.outputBindingId,
      t.deliveryId,
      t.attempt,
    ),
  ],
);

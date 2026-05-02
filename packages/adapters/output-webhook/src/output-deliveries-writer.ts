/**
 * `OutputDeliveryRow` — shape of an audit row for one delivery attempt
 * in the `output_deliveries` table (PR-J).
 *
 * # Append-only invariant (THREAT-MODEL §2 invariant 8)
 *
 * This module INSERT-only. Strategy (a) from the spec: each retry
 * attempt creates a NEW row. Status is fixed at insert time:
 *   - `pending`           → reserved for future speculative inserts
 *   - `success`           → 2xx response received
 *   - `transient_failure` → 5xx / network drop; will be retried
 *   - `dlq`               → terminal failure (all attempts exhausted,
 *                           or non-retryable 4xx/429)
 *
 * The (output_binding_id, delivery_id, attempt) triple is the natural
 * primary key. The table's UNIQUE constraint enforces that each attempt
 * for a given delivery is recorded exactly once.
 *
 * No UPDATE on prior rows. The latest attempt's status is authoritative.
 */

export type OutputDeliveryStatus =
  | "success"
  | "transient_failure"
  | "dlq";

export interface OutputDeliveryRow {
  /** UUID — the `output_deliveries.id` pk. Assigned by the DB. When
   *  writing to a real DB, omit and let `gen_random_uuid()` assign. */
  readonly id?: string;
  /** The output binding that triggered this delivery. */
  readonly outputBindingId: string;
  /** Deterministic delivery ID (UUID v5) scoping all attempts for one
   *  logical delivery. Same payload → same id (idempotency). */
  readonly deliveryId: string;
  /** Zero-based attempt counter. First attempt = 0. */
  readonly attempt: number;
  /** Fixed at insert time — never updated. */
  readonly status: OutputDeliveryStatus;
  /** HTTP status code returned by the upstream. `undefined` on
   *  network-level transient failures (no response). */
  readonly statusCode?: number;
  /** First 500 chars of the response body for diagnostics. Never
   *  includes credential bytes. */
  readonly responseBodyExcerpt?: string;
  /** Timestamp when the request was dispatched. */
  readonly sentAt: Date;
  /** Timestamp when the attempt completed (response received or
   *  error thrown). `undefined` when still in-flight — not used
   *  in this adapter since we await each attempt before writing. */
  readonly completedAt?: Date;
}

/**
 * Writer interface injected into the retry loop. The default (no-op)
 * implementation is used when no DB writer is provided (unit tests).
 * Production wiring passes a Drizzle-backed writer.
 */
export type OutputDeliveryWriter = (row: OutputDeliveryRow) => void | Promise<void>;

export const noOpDeliveryWriter: OutputDeliveryWriter = () => undefined;

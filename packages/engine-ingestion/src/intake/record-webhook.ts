/**
 * recordWebhook — INSERT-or-bump into webhook_events.
 *
 * Q12 (option a) approved: a duplicate `(provider, event_id)` row
 * is UPDATEd to `delivery_count = delivery_count + 1, received_at =
 * now()`, returning `{created:false, deliveryCount:<new>}`. The
 * webhook_events table is NOT in `APPEND_ONLY_TABLES` (verified
 * against `tools/eslint-plugin-opencoo/src/rules/no-update-append-only.ts`,
 * 6 entries: pageCitations, redactionEvents, erasureLog,
 * minerSuppressions, agentRuns, llmUsageDebug); the schema's
 * `delivery_count` column was deliberately designed for this
 * idempotency-via-update pattern.
 *
 * Rows without `event_id` ALWAYS INSERT — the partial UNIQUE index
 * has `WHERE event_id IS NOT NULL`, so collision detection is
 * impossible for unkeyed deliveries. Adapters that send no
 * idempotency key get a fresh row per delivery.
 *
 * `payload` defaults to null (Q13 privacy). PR 23+ adapters opt in
 * to retaining the payload by setting an explicit retention
 * policy on the binding.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

import { webhookEvents } from "@opencoo/shared/db/schema";

export interface RecordWebhookArgs {
  readonly db: PgDatabase<never, Record<string, never>, Record<string, never>>;
  readonly provider: string;
  /** Idempotency key from the upstream provider. `undefined` means
   *  the provider didn't send one — every delivery becomes a new row. */
  readonly eventId: string | undefined;
  readonly payloadHash: string;
  readonly signatureOk: boolean;
  readonly bindingId?: string;
}

export interface RecordWebhookResult {
  readonly created: boolean;
  readonly webhookId: string;
  readonly deliveryCount: number;
}

export async function recordWebhook(
  args: RecordWebhookArgs,
): Promise<RecordWebhookResult> {
  // Path A: no event_id → always INSERT a new row. The partial
  // UNIQUE index ignores rows where event_id IS NULL, so we cannot
  // dedupe and we must not pretend to.
  if (args.eventId === undefined) {
    const inserted = await args.db
      .insert(webhookEvents)
      .values({
        provider: args.provider,
        eventId: null,
        payloadHash: args.payloadHash,
        signatureOk: args.signatureOk,
        ...(args.bindingId !== undefined ? { bindingId: args.bindingId } : {}),
      })
      .returning({
        id: webhookEvents.id,
        deliveryCount: webhookEvents.deliveryCount,
      });
    if (inserted.length === 0) {
      throw new Error("recordWebhook: INSERT produced no rows");
    }
    const row = inserted[0]!;
    return { created: true, webhookId: row.id, deliveryCount: row.deliveryCount };
  }

  // Path B: event_id present → INSERT ... ON CONFLICT DO UPDATE
  // SET delivery_count = delivery_count + 1, received_at = now().
  // The RETURNING clause includes `xmax`: xmax='0' on a fresh
  // INSERT, xmax>0 on the conflict-update path.
  const inserted = await args.db
    .insert(webhookEvents)
    .values({
      provider: args.provider,
      eventId: args.eventId,
      payloadHash: args.payloadHash,
      signatureOk: args.signatureOk,
      ...(args.bindingId !== undefined ? { bindingId: args.bindingId } : {}),
    })
    .onConflictDoUpdate({
      target: [webhookEvents.provider, webhookEvents.eventId],
      // Partial UNIQUE index has `WHERE event_id IS NOT NULL` —
      // pass the same predicate as `targetWhere` so Postgres can
      // bind ON CONFLICT to that specific partial index. Without
      // this, the planner errors with "no unique or exclusion
      // constraint matching the ON CONFLICT specification".
      targetWhere: sql`${webhookEvents.eventId} IS NOT NULL`,
      // Increment delivery_count from the EXISTING row (not from
      // EXCLUDED — EXCLUDED is the row we tried to insert and its
      // delivery_count is the default 1; we want existing+1).
      set: {
        deliveryCount: sql`${webhookEvents.deliveryCount} + 1`,
        receivedAt: sql`now()`,
      },
    })
    .returning({
      id: webhookEvents.id,
      deliveryCount: webhookEvents.deliveryCount,
      xmax: sql<string>`xmax`,
    });

  if (inserted.length === 0) {
    throw new Error("recordWebhook: INSERT produced no rows");
  }
  const row = inserted[0]!;
  const created = String(row.xmax) === "0";
  return {
    created,
    webhookId: row.id,
    deliveryCount: row.deliveryCount,
  };
}

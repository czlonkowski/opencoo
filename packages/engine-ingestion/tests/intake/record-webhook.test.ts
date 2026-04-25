/**
 * recordWebhook — INSERT into webhook_events with delivery_count
 * dedupe semantics. Per Q12 option (a) approved by team-lead:
 * a duplicate `(provider, event_id)` row is UPDATED to
 * `delivery_count = delivery_count + 1, received_at = now()`,
 * returning `{created:false, deliveryCount:<new>}`.
 *
 * webhookEvents is NOT in the no-update-append-only allowlist
 * (verified empirically against rules/no-update-append-only.ts:18-25).
 * The schema's `delivery_count` column was deliberately designed
 * for this purpose.
 *
 * Rows without `event_id` (provider sent no idempotency key) ALWAYS
 * insert a new row — the partial UNIQUE index has
 * `WHERE event_id IS NOT NULL` so collision detection is impossible.
 */
import { describe, it, expect } from "vitest";

import { recordWebhook } from "../../src/intake/record-webhook.js";
import { freshIntakeDb } from "./_pglite-fixture.js";

const PAYLOAD_HASH = "sha256-abc";
const HASH_2 = "sha256-def";

describe("recordWebhook — happy path (insert)", () => {
  it("inserts a fresh row and returns {created:true, webhookId, deliveryCount:1}", async () => {
    const { db, bindingId } = await freshIntakeDb();
    const r = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    expect(r.created).toBe(true);
    expect(r.webhookId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.deliveryCount).toBe(1);
  });

  it("inserts with bindingId omitted (signature_ok:false path)", async () => {
    const { db } = await freshIntakeDb();
    const r = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-2",
      payloadHash: PAYLOAD_HASH,
      signatureOk: false,
    });
    expect(r.created).toBe(true);
    expect(r.deliveryCount).toBe(1);
  });

  it("inserts with eventId:undefined — providers that send no idempotency key", async () => {
    const { db, bindingId } = await freshIntakeDb();
    const r1 = await recordWebhook({
      db,
      provider: "anonymous",
      eventId: undefined,
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    expect(r1.created).toBe(true);
    expect(r1.deliveryCount).toBe(1);
  });
});

describe("recordWebhook — Q12 duplicate semantics (UPDATE delivery_count)", () => {
  it("on duplicate (provider, event_id) bumps delivery_count and returns {created:false, deliveryCount:2}", async () => {
    const { db, bindingId } = await freshIntakeDb();
    const r1 = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    const r2 = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: HASH_2, // even different payload, same event-id
      signatureOk: true,
      bindingId,
    });
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.deliveryCount).toBe(2);
    // Same row (UPDATE not INSERT)
    expect(r2.webhookId).toBe(r1.webhookId);
  });

  it("third delivery increments to 3", async () => {
    const { db, bindingId } = await freshIntakeDb();
    const args = {
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    } as const;
    await recordWebhook(args);
    await recordWebhook(args);
    const r3 = await recordWebhook(args);
    expect(r3.created).toBe(false);
    expect(r3.deliveryCount).toBe(3);
  });

  it("rows with eventId:null collide ONLY by chance (no UNIQUE) — both INSERT", async () => {
    const { db, bindingId } = await freshIntakeDb();
    const r1 = await recordWebhook({
      db,
      provider: "anonymous",
      eventId: undefined,
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    const r2 = await recordWebhook({
      db,
      provider: "anonymous",
      eventId: undefined,
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(true);
    expect(r2.webhookId).not.toBe(r1.webhookId);
    expect(r2.deliveryCount).toBe(1);
  });

  it("different providers with same event_id are independent (provider scopes the idempotency)", async () => {
    const { db, bindingId } = await freshIntakeDb();
    const r1 = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "shared-evt-id",
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    const r2 = await recordWebhook({
      db,
      provider: "github",
      eventId: "shared-evt-id",
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(true);
    expect(r2.webhookId).not.toBe(r1.webhookId);
  });
});

describe("recordWebhook — payload privacy (Q13)", () => {
  it("stores payload as null by default — PR 23+ adapter declares retention", async () => {
    const { db, bindingId } = await freshIntakeDb();
    const r = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    const rows = await db.execute(
      `SELECT payload FROM webhook_events WHERE id = '${r.webhookId}'`,
    );
    const row = rows.rows[0] as { payload: unknown };
    expect(row.payload).toBeNull();
  });
});

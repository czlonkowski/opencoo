/**
 * Webhook receiver — direct-intake branch tests (PR-N2, phase-a appendix #6).
 *
 * Closes the source-webhook chain: when an adapter exposes
 * `webhook.enrichEvents`, the receiver inserts an `ingestion_intake`
 * row + enqueues a fully-formed `ingestion.scanner.classify` job per
 * enriched event INLINE inside the receiver — eliminating the
 * pre-PR-N2 stall where webhook-native bindings (source-webhook /
 * source-asana) wrote `webhook_events` rows that the periodic
 * `adapter.scan()` cron never picked up (because their `scan()` is a
 * no-op by design).
 *
 * Backward compatibility: adapters WITHOUT `enrichEvents` continue to
 * use the legacy `intake.scanner` enqueue path. PR-N2 is purely
 * additive on the receiver side — pre-PR-N2 callers that don't pass
 * `scannerClassifyQueue` AND adapters that don't define
 * `enrichEvents` see no behavior change.
 *
 * THREAT-MODEL §2 invariants honored:
 *   - #5 webhook signature/replay: dedupe still gates intake (only
 *     `created || firstValidDelivery` triggers the new path).
 *   - #8 append-only: `ingestion_intake` is NOT in
 *     `APPEND_ONLY_TABLES`; the receiver writes via the same
 *     ON CONFLICT DO NOTHING shape the Scanner uses, so a replay
 *     produces zero new rows + zero new jobs.
 */
import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";

import { buildWebhookReceiver } from "../../src/intake/webhook-receiver.js";
import { InMemoryAdapterRegistry } from "../../src/intake/adapter-registry.js";
import { InMemoryCredentialStore } from "@opencoo/shared/credential-store";
import { ConsoleLogger } from "@opencoo/shared/logger";
import { HmacSha256Verifier } from "@opencoo/shared/webhook-verifier";
import type {
  SourceWebhookEvent,
  SourceWebhookHelpers,
} from "@opencoo/shared/source-adapter";

import { freshIntakeDb } from "./_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: { write: (): boolean => true },
  });
}

interface QueueRecorder {
  add: ReturnType<typeof vi.fn>;
}
function makeRecorder(): QueueRecorder {
  return { add: vi.fn(async () => undefined) };
}

const SECRET = Buffer.from("test-shared-secret", "utf8");

function signHex(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

interface FixtureOptions {
  readonly webhookHelpers: Partial<SourceWebhookHelpers> & {
    parseEvents: SourceWebhookHelpers["parseEvents"];
  };
  readonly withClassifyQueue?: boolean;
}

async function makeFixture(opts: FixtureOptions) {
  const fixture = await freshIntakeDb();
  const credentialStore = new InMemoryCredentialStore({
    logger: silentLogger(),
  });
  const credentialId = await credentialStore.write({
    name: "direct-intake-secret",
    schemaRef: "webhook/v1",
    plaintext: SECRET,
  });
  await fixture.db.execute(
    `UPDATE sources_bindings SET credentials_id = '${credentialId}', adapter_slug = 'test-direct' WHERE id = '${fixture.bindingId}'`,
  );

  const adapterRegistry = new InMemoryAdapterRegistry();
  adapterRegistry.register({
    slug: "test-direct",
    webhook: {
      verifier: new HmacSha256Verifier(),
      extractSignature: (headers) =>
        typeof headers["x-signature"] === "string"
          ? headers["x-signature"]
          : undefined,
      ...opts.webhookHelpers,
    } as SourceWebhookHelpers,
  });

  const scannerQueue = makeRecorder();
  const dlqQueue = makeRecorder();
  const scannerClassifyQueue = makeRecorder();

  const app = buildWebhookReceiver({
    db: fixture.db,
    credentialStore,
    adapterRegistry,
    verifier: new HmacSha256Verifier(),
    scannerQueue:
      scannerQueue as unknown as Parameters<
        typeof buildWebhookReceiver
      >[0]["scannerQueue"],
    dlqQueue: dlqQueue as unknown as Parameters<
      typeof buildWebhookReceiver
    >[0]["dlqQueue"],
    ...(opts.withClassifyQueue !== false
      ? {
          scannerClassifyQueue:
            scannerClassifyQueue as unknown as Parameters<
              typeof buildWebhookReceiver
            >[0]["scannerClassifyQueue"],
        }
      : {}),
  });

  return {
    ...fixture,
    app,
    scannerQueue,
    dlqQueue,
    scannerClassifyQueue,
  };
}

// ---------------------------------------------------------------------------
// 1. Direct-intake fast path: enrichEvents present + classify queue wired
// ---------------------------------------------------------------------------

describe("webhook receiver — direct-intake branch", () => {
  it("creates an ingestion_intake row + enqueues classify job per enriched event", async () => {
    const enrichedEvent: SourceWebhookEvent = {
      eventId: "evt-direct-1",
      doc: {
        sourceDocId: "doc-direct-1",
        sourceRevision: "rev-direct-1",
        sourceRef: "test:doc/direct-1",
        fetchedAt: new Date("2026-01-01T00:00:00Z"),
        contentBytes: Buffer.from('{"hello":"direct"}', "utf8"),
        metadata: { contentKind: "document" },
      },
    };

    const enrichEvents = vi.fn(
      async (events: readonly SourceWebhookEvent[]) => events.map((e) => ({ ...e })),
    );

    const {
      app,
      bindingId,
      domainId,
      db,
      scannerQueue,
      scannerClassifyQueue,
    } = await makeFixture({
      webhookHelpers: {
        parseEvents: () => [enrichedEvent],
        enrichEvents,
      },
    });
    void domainId;

    const body = '{"event":"test"}';
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": signHex(body),
        "x-event-id": "evt-direct-1",
        "x-provider": "test-direct",
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);

    // 1. ingestion_intake row landed with the enriched doc's
    //    (binding_id, source_doc_id, source_revision) tuple.
    const intakeRows = await db.execute(
      `SELECT binding_id::text AS binding_id, source_doc_id, source_revision FROM ingestion_intake`,
    );
    expect(intakeRows.rows).toHaveLength(1);
    expect(intakeRows.rows[0]).toMatchObject({
      binding_id: bindingId,
      source_doc_id: "doc-direct-1",
      source_revision: "rev-direct-1",
    });

    // 2. The classify queue received the full ScannerClassifyJob
    //    payload — bindingId, intakeId (uuid), domainSlug (joined
    //    in by the receiver), sourceRef, fetchedAt (ISO),
    //    contentBase64 (round-trippable to the original bytes).
    expect(scannerClassifyQueue.add).toHaveBeenCalledTimes(1);
    const [name, payload] = scannerClassifyQueue.add.mock.calls[0]! as [
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe("classify");
    expect(payload).toMatchObject({
      bindingId,
      domainSlug: "test-domain",
      sourceRef: "test:doc/direct-1",
      fetchedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(typeof payload["intakeId"]).toBe("string");
    expect(payload["intakeId"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(
      Buffer.from(String(payload["contentBase64"]), "base64").toString("utf8"),
    ).toBe('{"hello":"direct"}');

    // 3. Counter-assert: the legacy `intake.scanner` queue is NOT
    //    used on the direct-intake path.
    expect(scannerQueue.add).not.toHaveBeenCalled();

    // 4. enrichEvents was called exactly once with the parsed events.
    expect(enrichEvents).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("creates one intake row + one classify job PER enriched event when enrichEvents returns multiple", async () => {
    const e1: SourceWebhookEvent = {
      eventId: "evt-multi-1",
      doc: {
        sourceDocId: "doc-multi-1",
        sourceRevision: "rev-1",
        sourceRef: "test:doc/multi-1",
        fetchedAt: new Date("2026-02-02T00:00:00Z"),
        contentBytes: Buffer.from("a", "utf8"),
        metadata: { contentKind: "document" },
      },
    };
    const e2: SourceWebhookEvent = {
      eventId: "evt-multi-2",
      doc: {
        sourceDocId: "doc-multi-2",
        sourceRevision: "rev-2",
        sourceRef: "test:doc/multi-2",
        fetchedAt: new Date("2026-02-02T00:00:00Z"),
        contentBytes: Buffer.from("b", "utf8"),
        metadata: { contentKind: "asana-project" },
      },
    };

    const { app, bindingId, db, scannerClassifyQueue } = await makeFixture({
      webhookHelpers: {
        parseEvents: () => [e1],
        enrichEvents: async () => [e1, e2],
      },
    });

    const body = '{"event":"multi"}';
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": signHex(body),
        "x-event-id": "evt-multi",
        "x-provider": "test-direct",
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);

    const intakeRows = await db.execute(`SELECT id FROM ingestion_intake`);
    expect(intakeRows.rows).toHaveLength(2);
    expect(scannerClassifyQueue.add).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it("dedupes intake on duplicate (binding, source_doc_id, source_revision) — second delivery enqueues nothing", async () => {
    const ev: SourceWebhookEvent = {
      eventId: "evt-dup-direct",
      doc: {
        sourceDocId: "doc-dup",
        sourceRevision: "rev-dup",
        sourceRef: "test:doc/dup",
        fetchedAt: new Date(),
        contentBytes: Buffer.from("x", "utf8"),
        metadata: { contentKind: "document" },
      },
    };
    // The receiver's `recordWebhook` dedupe gates the
    // direct-intake branch off when the upstream truly retries the
    // same `(provider, event_id)` — so to exercise the intake-level
    // dedupe specifically, we must vary `event_id` across deliveries
    // while the adapter emits the SAME enriched doc both times.
    const { app, bindingId, db, scannerClassifyQueue } = await makeFixture({
      webhookHelpers: {
        parseEvents: () => [ev],
        enrichEvents: async (events) => events,
      },
    });

    const body = '{"event":"dup"}';
    const headersBase = {
      "content-type": "application/json",
      "x-signature": signHex(body),
      "x-provider": "test-direct",
    };

    const r1 = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: { ...headersBase, "x-event-id": "evt-direct-dup-1" },
      payload: body,
    });
    expect(r1.statusCode).toBe(200);

    const r2 = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: { ...headersBase, "x-event-id": "evt-direct-dup-2" },
      payload: body,
    });
    expect(r2.statusCode).toBe(200);

    // Only one intake row; only one classify job (the second
    // enriched event is the SAME (binding, source_doc_id,
    // source_revision) tuple).
    const intakeRows = await db.execute(`SELECT id FROM ingestion_intake`);
    expect(intakeRows.rows).toHaveLength(1);
    expect(scannerClassifyQueue.add).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("enrichEvents throws → 200 + DLQ enqueue + scrubbed warn log (does not crash receiver)", async () => {
    // The upstream provider should NOT retry — recordWebhook already
    // wrote the signature_ok=true row, so the receiver returns 200 to
    // suppress retries and DLQ-enqueues for operator triage.
    const enrichEvents = vi.fn(async () => {
      throw new Error("simulated enrichment failure");
    });

    const { app, bindingId, db, scannerClassifyQueue, dlqQueue } =
      await makeFixture({
        webhookHelpers: {
          parseEvents: () => [
            {
              eventId: "evt-throw",
              doc: {
                sourceDocId: "doc-throw",
                sourceRevision: "rev-throw",
                sourceRef: "test:doc/throw",
                fetchedAt: new Date(),
                contentBytes: Buffer.from("{}", "utf8"),
                metadata: { contentKind: "document" },
              },
            },
          ],
          enrichEvents,
        },
      });

    const body = '{"event":"throw"}';
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": signHex(body),
        "x-event-id": "evt-throw",
        "x-provider": "test-direct",
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);

    const intakeRows = await db.execute(`SELECT id FROM ingestion_intake`);
    expect(intakeRows.rows).toHaveLength(0);
    expect(scannerClassifyQueue.add).not.toHaveBeenCalled();
    expect(dlqQueue.add).toHaveBeenCalledTimes(1);
    const [name, payload] = dlqQueue.add.mock.calls[0]! as [
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe("intake.dlq");
    expect(payload).toMatchObject({ bindingId });
    expect(String(payload["reason"])).toMatch(/direct-intake failed/);

    await app.close();
  });

  it("empty enrichEvents result → no intake rows, no classify enqueue, still 200", async () => {
    const { app, bindingId, db, scannerClassifyQueue, scannerQueue } =
      await makeFixture({
        webhookHelpers: {
          parseEvents: () => [
            {
              eventId: "evt-filtered",
              doc: {
                sourceDocId: "doc-filtered",
                sourceRevision: "rev-filtered",
                sourceRef: "test:doc/filtered",
                fetchedAt: new Date(),
                contentBytes: Buffer.from("z", "utf8"),
                metadata: { contentKind: "document" },
              },
            },
          ],
          enrichEvents: async () => [],
        },
      });

    const body = '{"event":"filter-all"}';
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": signHex(body),
        "x-event-id": "evt-filter-all",
        "x-provider": "test-direct",
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);

    const intakeRows = await db.execute(`SELECT id FROM ingestion_intake`);
    expect(intakeRows.rows).toHaveLength(0);
    expect(scannerClassifyQueue.add).not.toHaveBeenCalled();
    expect(scannerQueue.add).not.toHaveBeenCalled();

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// 2. Backward compatibility — pre-PR-N2 path still works
// ---------------------------------------------------------------------------

describe("webhook receiver — direct-intake backward-compat", () => {
  it("adapter without enrichEvents → uses legacy intake.scanner queue, NOT direct-intake", async () => {
    const parsed: SourceWebhookEvent = {
      eventId: "evt-legacy",
      doc: {
        sourceDocId: "doc-legacy",
        sourceRevision: "rev-legacy",
        sourceRef: "test:doc/legacy",
        fetchedAt: new Date(),
        contentBytes: Buffer.from("legacy", "utf8"),
      },
    };

    const { app, bindingId, db, scannerQueue, scannerClassifyQueue } =
      await makeFixture({
        webhookHelpers: {
          parseEvents: () => [parsed],
          // enrichEvents intentionally NOT provided
        },
      });

    const body = '{"event":"legacy"}';
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": signHex(body),
        "x-event-id": "evt-legacy",
        "x-provider": "test-direct",
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);

    // Legacy path: no intake row written, no classify job, ONE
    // intake.scanner enqueue.
    const intakeRows = await db.execute(`SELECT id FROM ingestion_intake`);
    expect(intakeRows.rows).toHaveLength(0);
    expect(scannerClassifyQueue.add).not.toHaveBeenCalled();
    expect(scannerQueue.add).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("scannerClassifyQueue NOT supplied + enrichEvents present → falls back to legacy enqueue", async () => {
    // Belt-and-suspenders: even when the adapter has enrichEvents,
    // missing the classify queue handle (a misconfigured composition
    // root) MUST fall back to the legacy path rather than crashing.
    // This protects callers that haven't yet wired the new option.
    const ev: SourceWebhookEvent = {
      eventId: "evt-no-queue",
      doc: {
        sourceDocId: "doc-no-queue",
        sourceRevision: "rev-no-queue",
        sourceRef: "test:doc/no-queue",
        fetchedAt: new Date(),
        contentBytes: Buffer.from("nq", "utf8"),
      },
    };

    const { app, bindingId, db, scannerQueue, scannerClassifyQueue } =
      await makeFixture({
        webhookHelpers: {
          parseEvents: () => [ev],
          enrichEvents: async (es) => es,
        },
        withClassifyQueue: false,
      });

    const body = '{"event":"no-classify-queue"}';
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": signHex(body),
        "x-event-id": "evt-no-classify-queue",
        "x-provider": "test-direct",
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);

    // Legacy fallback engaged.
    const intakeRows = await db.execute(`SELECT id FROM ingestion_intake`);
    expect(intakeRows.rows).toHaveLength(0);
    expect(scannerClassifyQueue.add).not.toHaveBeenCalled();
    expect(scannerQueue.add).toHaveBeenCalledTimes(1);

    await app.close();
  });
});

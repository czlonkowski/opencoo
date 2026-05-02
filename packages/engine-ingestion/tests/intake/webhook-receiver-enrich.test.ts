/**
 * Webhook receiver — enrichEvents wiring tests (PR-G).
 *
 * Tests:
 *   1. When adapter.webhook.enrichEvents is defined and returns additional
 *      events, ALL returned events are enqueued (not just the originals).
 *   2. When adapter.webhook.enrichEvents is undefined, behavior is identical
 *      to today (backward-compat).
 *   3. enrichEvents is called AFTER parseEvents, BEFORE recordWebhook (i.e.
 *      the snapshot events also follow the normal intake path).
 */
import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";

import { buildWebhookReceiver } from "../../src/intake/webhook-receiver.js";
import { InMemoryAdapterRegistry } from "../../src/intake/adapter-registry.js";
import { InMemoryCredentialStore } from "@opencoo/shared/credential-store";
import { ConsoleLogger } from "@opencoo/shared/logger";
import { HmacSha256Verifier } from "@opencoo/shared/webhook-verifier";
import type { SourceWebhookEvent, SourceWebhookHelpers } from "@opencoo/shared/source-adapter";

import { freshIntakeDb } from "./_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
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

async function makeFixtureWithAdapter(
  webhookHelpers: Partial<SourceWebhookHelpers> & {
    parseEvents: SourceWebhookHelpers["parseEvents"];
  },
) {
  const fixture = await freshIntakeDb();
  const credentialStore = new InMemoryCredentialStore({ logger: silentLogger() });
  const credentialId = await credentialStore.write({
    name: "test-webhook-secret",
    schemaRef: "webhook/v1",
    plaintext: SECRET,
  });
  await fixture.db.execute(
    `UPDATE sources_bindings SET credentials_id = '${credentialId}', adapter_slug = 'test-enrich' WHERE id = '${fixture.bindingId}'`,
  );

  const adapterRegistry = new InMemoryAdapterRegistry();
  // Register a stub adapter with the provided webhook helpers
  adapterRegistry.register({
    slug: "test-enrich",
    webhook: {
      verifier: new HmacSha256Verifier(),
      extractSignature: (headers) =>
        typeof headers["x-signature"] === "string"
          ? headers["x-signature"]
          : undefined,
      ...webhookHelpers,
    } as SourceWebhookHelpers,
  });

  const scannerQueue = makeRecorder();
  const dlqQueue = makeRecorder();

  const app = buildWebhookReceiver({
    db: fixture.db,
    credentialStore,
    adapterRegistry,
    verifier: new HmacSha256Verifier(),
    scannerQueue: scannerQueue as unknown as Parameters<typeof buildWebhookReceiver>[0]["scannerQueue"],
    dlqQueue: dlqQueue as unknown as Parameters<typeof buildWebhookReceiver>[0]["dlqQueue"],
  });

  return { ...fixture, app, scannerQueue, dlqQueue };
}

// ---------------------------------------------------------------------------
// 1. enrichEvents=undefined: backward-compat (no change)
// ---------------------------------------------------------------------------

describe("webhook receiver — enrichEvents backward-compat", () => {
  it("works exactly as before when enrichEvents is not defined", async () => {
    const parsedEvent: SourceWebhookEvent = {
      eventId: "evt-100",
      doc: {
        sourceDocId: "doc-1",
        sourceRevision: "rev-1",
        sourceRef: "test:doc/1",
        fetchedAt: new Date(),
        contentBytes: Buffer.from("{}", "utf8"),
      },
    };

    const { app, bindingId, scannerQueue } = await makeFixtureWithAdapter({
      parseEvents: () => [parsedEvent],
      // enrichEvents intentionally NOT provided
    });

    const body = '{"event":"test"}';
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": signHex(body),
        "x-provider": "test-enrich",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(scannerQueue.add).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// 2. enrichEvents adds extra events — all get enqueued
// ---------------------------------------------------------------------------

describe("webhook receiver — enrichEvents adds events", () => {
  it("enqueues additional events returned by enrichEvents", async () => {
    const baseEvent: SourceWebhookEvent = {
      eventId: "evt-base",
      doc: {
        sourceDocId: "task-1",
        sourceRevision: "rev-base",
        sourceRef: "test:task/1",
        fetchedAt: new Date(),
        contentBytes: Buffer.from("{}", "utf8"),
      },
    };
    const snapshotEvent: SourceWebhookEvent = {
      eventId: "evt-snapshot",
      doc: {
        sourceDocId: "proj-snapshot",
        sourceRevision: "rev-snap",
        sourceRef: "test:project/1",
        fetchedAt: new Date(),
        contentBytes: Buffer.from('{"project_gid":"proj-1"}', "utf8"),
      },
    };

    const enrichEvents = vi.fn(async (events: SourceWebhookEvent[]) => {
      // Return original + snapshot
      return [...events, snapshotEvent];
    });

    const { app, bindingId, scannerQueue } = await makeFixtureWithAdapter({
      parseEvents: () => [baseEvent],
      enrichEvents,
    });

    const body = '{"event":"test"}';
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": signHex(body),
        "x-provider": "test-enrich",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    // enrichEvents was called
    expect(enrichEvents).toHaveBeenCalledTimes(1);
    expect(enrichEvents).toHaveBeenCalledWith([baseEvent]);
    // Both the base event and the snapshot event are enqueued
    expect(scannerQueue.add).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("enrichEvents is called after parseEvents (receives parsed events)", async () => {
    const parsedEvent: SourceWebhookEvent = {
      eventId: "evt-parsed",
      doc: {
        sourceDocId: "task-parsed",
        sourceRevision: "rev-parsed",
        sourceRef: "test:task/parsed",
        fetchedAt: new Date(),
        contentBytes: Buffer.from("{}", "utf8"),
      },
    };

    const enrichEvents = vi.fn(async (events: SourceWebhookEvent[]) => events);

    const { app, bindingId } = await makeFixtureWithAdapter({
      parseEvents: () => [parsedEvent],
      enrichEvents,
    });

    const body = '{"event":"test"}';
    await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": signHex(body),
        "x-provider": "test-enrich",
      },
      payload: body,
    });

    // enrichEvents receives the result of parseEvents
    expect(enrichEvents).toHaveBeenCalledWith([parsedEvent]);
    await app.close();
  });
});

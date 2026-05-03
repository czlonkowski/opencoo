/**
 * source-asana benefits from the direct-intake fast path (PR-N2).
 *
 * The Asana SourceAdapter has exposed `webhook.enrichEvents` since
 * PR-G (`packages/adapters/source-asana/src/adapter.ts:314-422`) for
 * a different purpose: appending project-snapshot events fetched from
 * the Asana REST API. PR-N2 makes that same `enrichEvents` flag the
 * receiver-side trigger for inserting `ingestion_intake` rows
 * directly. So Asana webhook deliveries — which previously stalled at
 * `webhook_events` (Asana's `scan()` is a no-op by design,
 * `packages/adapters/source-asana/src/adapter.ts`) — now flow all the
 * way through to a `ingestion.scanner.classify` job inline.
 *
 * This test pins that behavior by using the same engine-ingestion
 * receiver end-to-end against a stub Asana-shaped adapter. It does
 * NOT import `@opencoo/source-asana` (the engine-ingestion package
 * deliberately doesn't depend on specific source adapters per
 * CLAUDE.md "Adapter boundaries"); the adapter shape — slug='asana',
 * webhook helpers carrying `enrichEvents` — is what matters.
 */
import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";

import { buildWebhookReceiver } from "../../src/intake/webhook-receiver.js";
import { InMemoryAdapterRegistry } from "../../src/intake/adapter-registry.js";
import { InMemoryCredentialStore } from "@opencoo/shared/credential-store";
import { ConsoleLogger } from "@opencoo/shared/logger";
import { HmacSha256Verifier } from "@opencoo/shared/webhook-verifier";
import type { SourceAdapter } from "@opencoo/shared/source-adapter";

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

const SECRET = Buffer.from("asana-webhook-secret", "utf8");

function signHex(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

/** Minimal asana-shaped SourceAdapter — slug='asana', webhook
 *  helpers carrying `enrichEvents` that returns one base event +
 *  one snapshot event (the source-asana production shape). */
function buildStubAsanaAdapter(): SourceAdapter {
  return {
    slug: "asana",
    async scan() {
      return { documents: [], nextCursor: null };
    },
    webhook: {
      verifier: new HmacSha256Verifier(),
      extractSignature: (headers) =>
        typeof headers["x-signature"] === "string"
          ? headers["x-signature"]
          : undefined,
      parseEvents: () => [
        {
          eventId: "asana-evt-base",
          eventType: "task.changed",
          doc: {
            sourceDocId: "asana-task-1",
            sourceRevision: "asana-rev-1",
            sourceRef: "asana:task/1",
            fetchedAt: new Date("2026-04-01T00:00:00Z"),
            contentBytes: Buffer.from('{"task":"base"}', "utf8"),
            metadata: { contentKind: "document" },
          },
        },
      ],
      // Mirrors the shape source-asana's own enrichEvents emits:
      // one base event + one snapshot event with
      // contentKind='asana-project'.
      enrichEvents: async (events) => {
        const out = [...events];
        out.push({
          eventId: "asana-evt-snapshot",
          eventType: "task.changed.snapshot",
          doc: {
            sourceDocId: "asana-project-1-snapshot",
            sourceRevision: "asana-snap-1",
            sourceRef: "asana:project/1/snapshot",
            fetchedAt: new Date("2026-04-01T00:00:00Z"),
            contentBytes: Buffer.from('{"project":{"gid":"1"}}', "utf8"),
            metadata: { contentKind: "asana-project" },
          },
        });
        return out;
      },
    },
  };
}

describe("asana receiver — direct-intake fast path", () => {
  it("a single Asana webhook delivery produces an ingestion_intake row PER enriched event + a classify job per row", async () => {
    const fixture = await freshIntakeDb();
    const credentialStore = new InMemoryCredentialStore({
      logger: silentLogger(),
    });
    const credentialId = await credentialStore.write({
      name: "asana-webhook-secret",
      schemaRef: "source-asana:webhook_secret",
      plaintext: SECRET,
    });
    await fixture.db.execute(
      `UPDATE sources_bindings SET credentials_id = '${credentialId}', adapter_slug = 'asana' WHERE id = '${fixture.bindingId}'`,
    );

    const adapterRegistry = new InMemoryAdapterRegistry();
    adapterRegistry.register(buildStubAsanaAdapter());

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
      scannerClassifyQueue:
        scannerClassifyQueue as unknown as Parameters<
          typeof buildWebhookReceiver
        >[0]["scannerClassifyQueue"],
    });

    const body = '{"events":[{"resource":{"gid":"1"}}]}';
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${fixture.bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": signHex(body),
        "x-event-id": "asana-delivery-1",
        "x-provider": "asana",
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);

    // PR-N2: TWO intake rows landed (base + snapshot).
    const intakeRows = await fixture.db.execute(
      `SELECT source_doc_id FROM ingestion_intake ORDER BY source_doc_id`,
    );
    expect(intakeRows.rows).toHaveLength(2);
    const docIds = intakeRows.rows.map(
      (r) => (r as { source_doc_id: string }).source_doc_id,
    );
    expect(docIds).toContain("asana-task-1");
    expect(docIds).toContain("asana-project-1-snapshot");

    // PR-N2: TWO classify jobs enqueued (one per intake row).
    expect(scannerClassifyQueue.add).toHaveBeenCalledTimes(2);

    // Counter-assert: legacy intake.scanner queue is BYPASSED.
    expect(scannerQueue.add).not.toHaveBeenCalled();

    await app.close();
  });
});

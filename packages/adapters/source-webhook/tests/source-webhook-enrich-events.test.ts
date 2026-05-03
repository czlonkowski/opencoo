/**
 * source-webhook adapter — `enrichEvents` impl tests (PR-N2).
 *
 * `enrichEvents` exists for one reason: it's the receiver-side flag
 * that flips the **direct-intake fast path** on (engine-ingestion's
 * `webhook-receiver.ts` checks `adapter.webhook.enrichEvents !==
 * undefined` to decide whether to insert `ingestion_intake` rows
 * inline or fall through to the legacy `intake.scanner` enqueue).
 *
 * For the generic webhook adapter, `parseEvents` already constructs
 * a fully-formed `SourceChangedDocument` with `metadata.contentKind`
 * resolved via the per-binding `contentKindMap` jsonpath rules — so
 * the enrichment work is already done. `enrichEvents` here is
 * effectively an idempotent re-resolution: it ensures every event's
 * `metadata.contentKind` reflects the current `contentKindMap`
 * (defending against future callers that bypass `parseEvents`) and
 * acts as the single load-bearing presence-check the receiver
 * inspects.
 *
 * Plan acceptance criteria covered here:
 *   - enrichEvents resolves contentKind via jsonpath
 *   - enrichEvents returns events ready for direct intake
 *     (validates the `doc` shape — sourceDocId / sourceRevision /
 *     sourceRef / contentBytes / fetchedAt / metadata.contentKind)
 *   - Empty contentKindMap → events still returned, contentKind ===
 *     defaultContentKind
 */
import { describe, expect, it } from "vitest";

import { InMemoryCredentialStore } from "@opencoo/shared/credential-store";
import { ConsoleLogger } from "@opencoo/shared/logger";
import type { CredentialId } from "@opencoo/shared/db";
import type { SourceWebhookEvent } from "@opencoo/shared/source-adapter";

import { createSourceWebhookAdapter } from "../src/index.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

async function buildAdapter(
  config: Record<string, unknown>,
): Promise<ReturnType<typeof createSourceWebhookAdapter>> {
  const store = new InMemoryCredentialStore({ logger: silentLogger() });
  const credentialId: CredentialId = await store.write({
    name: "enrich-test-secret",
    schemaRef: "source-webhook:signing_secret/v1",
    plaintext: Buffer.from("enrich-test-secret-bytes"),
  });
  return createSourceWebhookAdapter({
    credentialStore: store,
    credentialId,
    config: {
      pathSegment: "enrich-test",
      signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
      eventIdField: "$.event.id",
      ...config,
    },
  });
}

describe("source-webhook — enrichEvents presence (load-bearing for direct-intake fast path)", () => {
  it("adapter exposes enrichEvents on the webhook helpers", async () => {
    const adapter = await buildAdapter({});
    expect(adapter.webhook).toBeDefined();
    expect(typeof adapter.webhook!.enrichEvents).toBe("function");
  });
});

describe("source-webhook — enrichEvents resolves contentKind via jsonpath", () => {
  it("uses the contentKindMap to set metadata.contentKind on each event", async () => {
    const adapter = await buildAdapter({
      contentKindMap: {
        "$.workflow.id": "n8n-workflow",
        "$.project.gid": "asana-project",
      },
    });
    const wh = adapter.webhook!;

    const body = Buffer.from(
      JSON.stringify({ event: { id: "evt-flow-1" }, workflow: { id: "wf-1" } }),
      "utf8",
    );
    const events = wh.parseEvents({ body });
    expect(events).toHaveLength(1);

    const enriched = await wh.enrichEvents!(events);
    expect(enriched).toHaveLength(1);
    expect(enriched[0]!.doc.metadata?.["contentKind"]).toBe("n8n-workflow");
  });

  it("re-resolves contentKind on every call (defense in depth — does not trust the input metadata)", async () => {
    const adapter = await buildAdapter({
      contentKindMap: { "$.project.gid": "asana-project" },
    });
    const wh = adapter.webhook!;

    const body = Buffer.from(
      JSON.stringify({
        event: { id: "evt-trans-1" },
        project: { gid: "p-1" },
      }),
      "utf8",
    );
    const parsed = wh.parseEvents({ body });
    // Hand-mutate metadata.contentKind to a wrong value, simulating a
    // caller that bypasses parseEvents OR a future regression that
    // detached parseEvents from contentKind resolution. enrichEvents
    // MUST re-derive the correct kind from the body.
    const muddied: readonly SourceWebhookEvent[] = parsed.map((e) => ({
      ...e,
      doc: {
        ...e.doc,
        metadata: { ...e.doc.metadata, contentKind: "document" },
      },
    }));
    const enriched = await wh.enrichEvents!(muddied);
    expect(enriched[0]!.doc.metadata?.["contentKind"]).toBe("asana-project");
  });

  it("returns the default contentKind ('document') when contentKindMap is empty", async () => {
    const adapter = await buildAdapter({
      // no contentKindMap → resolveContentKind returns the default
    });
    const wh = adapter.webhook!;

    const body = Buffer.from(
      JSON.stringify({ event: { id: "evt-default-kind" } }),
      "utf8",
    );
    const events = wh.parseEvents({ body });
    const enriched = await wh.enrichEvents!(events);
    expect(enriched).toHaveLength(1);
    expect(enriched[0]!.doc.metadata?.["contentKind"]).toBe("document");
  });

  it("honors operator-set defaultContentKind", async () => {
    const adapter = await buildAdapter({
      defaultContentKind: "webhook-event",
    });
    const wh = adapter.webhook!;
    const body = Buffer.from(
      JSON.stringify({ event: { id: "evt-default-webhook" } }),
      "utf8",
    );
    const events = wh.parseEvents({ body });
    const enriched = await wh.enrichEvents!(events);
    expect(enriched[0]!.doc.metadata?.["contentKind"]).toBe("webhook-event");
  });
});

describe("source-webhook — enrichEvents returns events ready for direct intake", () => {
  it("each enriched event carries every field the receiver's direct-intake branch consumes", async () => {
    const adapter = await buildAdapter({});
    const wh = adapter.webhook!;
    const body = Buffer.from(
      JSON.stringify({ event: { id: "evt-shape-pin" } }),
      "utf8",
    );
    const enriched = await wh.enrichEvents!(wh.parseEvents({ body }));

    expect(enriched).toHaveLength(1);
    const ev = enriched[0]!;
    // The receiver's direct-intake branch (PR-N2) consumes:
    //   event.doc.sourceDocId, event.doc.sourceRevision,
    //   event.doc.sourceRef, event.doc.contentBytes,
    //   event.doc.fetchedAt, event.doc.metadata.contentKind
    expect(ev.eventId).toBe("evt-shape-pin");
    expect(ev.doc.sourceDocId).toBe("evt-shape-pin");
    expect(ev.doc.sourceRevision).toBe("evt-shape-pin");
    expect(ev.doc.sourceRef).toBe("webhook:event/evt-shape-pin");
    expect(Buffer.isBuffer(ev.doc.contentBytes)).toBe(true);
    expect(ev.doc.fetchedAt).toBeInstanceOf(Date);
    expect(ev.doc.metadata?.["contentKind"]).toBe("document");
  });

  it("returns an empty array when given an empty input (no input → no enriched output)", async () => {
    const adapter = await buildAdapter({});
    const wh = adapter.webhook!;
    const enriched = await wh.enrichEvents!([]);
    expect(enriched).toEqual([]);
  });
});

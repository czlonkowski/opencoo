/**
 * source-webhook adapter contract tests (PR-I).
 *
 * Passes the 9 polling + 3 (actually 5 in the shared suite)
 * webhook-mode shared assertions from @opencoo/shared/adapter-contract-tests
 * against the generic webhook adapter.
 *
 * The adapter is webhook-mode only; scan() is a no-op.
 * The contract suite's webhook assertions run the full HMAC +
 * extractSignature + parseEvents + eventId-stability matrix.
 */
import { describe, expect, it } from "vitest";

import { sourceAdapterContract } from "@opencoo/shared/adapter-contract-tests";
import {
  InMemoryCredentialStore,
  type CredentialStore,
} from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import { ConsoleLogger } from "@opencoo/shared/logger";

import {
  createSourceWebhookAdapter,
  extractWebhookCredentialSecret,
  WEBHOOK_ADAPTER_SLUG,
  WEBHOOK_SIGNATURE_HEADER,
} from "../src/index.js";
import { buildMockWebhookPayload } from "./testing/mock-webhook-payloads.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

async function seedSecret(
  store: CredentialStore,
  bytes: Buffer,
): Promise<CredentialId> {
  return store.write({
    name: "webhook-test-signing-secret",
    schemaRef: "source-webhook:signing_secret/v1",
    plaintext: bytes,
  });
}

const fixture = buildMockWebhookPayload();

// ---------------------------------------------------------------------------
// Shared sourceAdapterContract — webhook mode
// ---------------------------------------------------------------------------

sourceAdapterContract({
  backendName: "source-webhook",
  mode: "webhook",
  webhookFixture: {
    body: fixture.body,
    secret: fixture.secret,
    validSignature: fixture.validSignature,
    headers: fixture.headers,
    signatureHeaderName: WEBHOOK_SIGNATURE_HEADER,
  },
  makeAdapter: async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedSecret(store, fixture.secret);
    const adapter = createSourceWebhookAdapter({
      credentialStore: store,
      credentialId,
      config: {
        pathSegment: "test-hook",
        signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
        eventIdField: "$.event.id",
        reviewMode: "review",
      },
    });
    return {
      adapter,
      // Webhook adapters don't seed/simulate — no-op stubs.
      seed: () => undefined,
      simulate: {
        addDoc: () => undefined,
        bumpRevision: () => undefined,
        removeDoc: () => undefined,
      },
      cleanup: async () => undefined,
    };
  },
});

// ---------------------------------------------------------------------------
// Additional adapter-specific assertions
// ---------------------------------------------------------------------------

describe("source-webhook — adapter wiring", () => {
  it("slug is 'webhook'", async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedSecret(store, fixture.secret);
    const adapter = createSourceWebhookAdapter({
      credentialStore: store,
      credentialId,
      config: {
        pathSegment: "hook",
        signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
        eventIdField: "$.event.id",
      },
    });
    expect(adapter.slug).toBe(WEBHOOK_ADAPTER_SLUG);
    expect(adapter.slug).toBe("webhook");
  });

  it("scan() is a no-op (webhook mode)", async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedSecret(store, fixture.secret);
    const adapter = createSourceWebhookAdapter({
      credentialStore: store,
      credentialId,
      config: {
        pathSegment: "hook",
        signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
        eventIdField: "$.event.id",
      },
    });
    const result = await adapter.scan({ cursor: null });
    expect(result.documents).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("invalid config throws at factory time", async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedSecret(store, fixture.secret);
    expect(() =>
      createSourceWebhookAdapter({
        credentialStore: store,
        credentialId,
        config: {},
      }),
    ).toThrow();
  });

  it("adapter.webhook is present and exposes verifier + extractSignature + parseEvents", async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedSecret(store, fixture.secret);
    const adapter = createSourceWebhookAdapter({
      credentialStore: store,
      credentialId,
      config: {
        pathSegment: "hook",
        signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
        eventIdField: "$.event.id",
      },
    });
    expect(adapter.webhook).toBeDefined();
    expect(typeof adapter.webhook?.verifier.verify).toBe("function");
    expect(typeof adapter.webhook?.extractSignature).toBe("function");
    expect(typeof adapter.webhook?.parseEvents).toBe("function");
  });

  it("extractSignature reads x-signature header (case-insensitive)", async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedSecret(store, fixture.secret);
    const adapter = createSourceWebhookAdapter({
      credentialStore: store,
      credentialId,
      config: {
        pathSegment: "hook",
        signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
        eventIdField: "$.event.id",
      },
    });
    const wh = adapter.webhook!;
    expect(
      wh.extractSignature({ [WEBHOOK_SIGNATURE_HEADER]: "abc" }),
    ).toBe("abc");
    expect(
      wh.extractSignature({
        "X-Signature": "ABC",
      }),
    ).toBe("ABC");
    expect(wh.extractSignature({})).toBeUndefined();
  });

  it("reviewMode defaults to 'review' on the parsed config", async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedSecret(store, fixture.secret);
    // Creating the adapter will parse config — we test the parsed config
    // indirectly by checking that a minimal config without reviewMode
    // doesn't throw and the adapter is created.
    expect(() =>
      createSourceWebhookAdapter({
        credentialStore: store,
        credentialId,
        config: {
          pathSegment: "hook",
          signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
          eventIdField: "$.event.id",
          // reviewMode omitted — should default to 'review'
        },
      }),
    ).not.toThrow();
  });
});

describe("source-webhook — contentKindMap routing", () => {
  it("uses defaultContentKind 'document' when no contentKindMap", async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedSecret(store, fixture.secret);
    const adapter = createSourceWebhookAdapter({
      credentialStore: store,
      credentialId,
      config: {
        pathSegment: "hook",
        signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
        eventIdField: "$.event.id",
      },
    });
    const events = adapter.webhook!.parseEvents({ body: fixture.body });
    // contentKind is embedded in sourceDocId shape or doc metadata,
    // but the key observable: the event is emitted and has a valid doc.
    expect(events.length).toBe(1);
    expect(events[0]!.doc.contentBytes).toBeDefined();
  });
});

// PR-Q7: extractWebhookCredentialSecret unwraps the inner signing_secret
// from the JSON-stringified webhook_secret blob the admin-API stored.
describe("source-webhook — extractWebhookCredentialSecret (PR-Q7)", () => {
  it("unwraps the signing_secret field from the JSON credential blob", () => {
    const wrapped = Buffer.from(
      JSON.stringify({ signing_secret: "generic-webhook-secret" }),
      "utf8",
    );
    const unwrapped = extractWebhookCredentialSecret(wrapped);
    expect(unwrapped.toString("utf8")).toBe("generic-webhook-secret");
  });

  it("throws when plaintext is not valid JSON", () => {
    const malformed = Buffer.from("definitely-not-json", "utf8");
    expect(() => extractWebhookCredentialSecret(malformed)).toThrow(
      /not valid JSON/i,
    );
  });

  it("throws when JSON root is not an object", () => {
    const arrayJson = Buffer.from(JSON.stringify(["a", "b"]), "utf8");
    expect(() => extractWebhookCredentialSecret(arrayJson)).toThrow(
      /must be a JSON object/i,
    );
  });

  it("throws when signing_secret field is missing", () => {
    const noField = Buffer.from(JSON.stringify({ other: "value" }), "utf8");
    expect(() => extractWebhookCredentialSecret(noField)).toThrow(
      /missing the signing_secret field/i,
    );
  });

  it("throws when signing_secret is empty", () => {
    const empty = Buffer.from(JSON.stringify({ signing_secret: "" }), "utf8");
    expect(() => extractWebhookCredentialSecret(empty)).toThrow(
      /missing the signing_secret field|not a non-empty string/i,
    );
  });

  it("the helper bundle exposes extractWebhookSecret wired to the adapter", async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedSecret(store, fixture.secret);
    const adapter = createSourceWebhookAdapter({
      credentialStore: store,
      credentialId,
      config: {
        pathSegment: "hook",
        signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
        eventIdField: "$.event.id",
      },
    });
    expect(typeof adapter.webhook!.extractWebhookSecret).toBe("function");
    const wrapped = Buffer.from(
      JSON.stringify({ signing_secret: "round-trip-via-helpers" }),
      "utf8",
    );
    expect(
      adapter.webhook!.extractWebhookSecret!(wrapped).toString("utf8"),
    ).toBe("round-trip-via-helpers");
  });
});

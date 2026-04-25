/**
 * source-fireflies adapter tests (PR 27 / plan #126).
 *
 * Layers:
 *   1. Shared sourceAdapterContract({mode:'webhook'}) — runs the
 *      5 webhook assertions against the adapter wired with the
 *      mock fixture. Exercises verifier + extractSignature +
 *      parseEvents end-to-end.
 *   2. Adapter-specific tests covering binding-config Zod
 *      validation (full reviewMode enum auto|approve|review,
 *      DEFAULT 'approve' — PoC's transcription bindings ship
 *      review-required), signature header case-insensitive
 *      lookup, single-event-per-request envelope, eventId
 *      revision-fallback (when revision absent → use
 *      transcriptId), 1 MiB ceiling, meetingTitleAllowlist
 *      operator filter (case-insensitive substring match),
 *      sourceRef shape, no-pre-spotlight invariant.
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
  FIREFLIES_ADAPTER_SLUG,
  FIREFLIES_SIGNATURE_HEADER,
  buildFirefliesWebhookHelpers,
  createFirefliesSourceAdapter,
  extractFirefliesSignature,
  firefliesBindingConfigSchema,
} from "../src/index.js";
import { buildMockFirefliesWebhookFixture } from "../src/testing/mock-fireflies-events.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

async function seedSecret(
  store: CredentialStore,
  bytes: Buffer,
): Promise<CredentialId> {
  return store.write({
    name: "fireflies-test-webhook-secret",
    schemaRef: "fireflies-webhook-secret/v1",
    plaintext: bytes,
  });
}

interface MakeFixtureOptions {
  readonly config?: Record<string, unknown>;
  readonly secret?: Buffer;
}

async function makeFixture(opts: MakeFixtureOptions = {}): Promise<{
  readonly store: CredentialStore;
  readonly credentialId: CredentialId;
  readonly adapter: ReturnType<typeof createFirefliesSourceAdapter>;
}> {
  const store = new InMemoryCredentialStore({ logger: silentLogger() });
  const credentialId = await seedSecret(
    store,
    opts.secret ?? Buffer.from("fireflies-test-secret"),
  );
  const adapter = createFirefliesSourceAdapter({
    credentialStore: store,
    credentialId,
    config: opts.config ?? { webhookSecretCredentialId: credentialId },
  });
  return { store, credentialId, adapter };
}

// ---------------------------------------------------------------------------
// Shared sourceAdapterContract — webhook mode
// ---------------------------------------------------------------------------

const fixture = buildMockFirefliesWebhookFixture();

sourceAdapterContract({
  backendName: "source-fireflies",
  mode: "webhook",
  webhookFixture: {
    body: fixture.body,
    secret: fixture.secret,
    validSignature: fixture.validSignature,
    headers: fixture.headers,
    signatureHeaderName: FIREFLIES_SIGNATURE_HEADER,
  },
  makeAdapter: async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedSecret(store, fixture.secret);
    const adapter = createFirefliesSourceAdapter({
      credentialStore: store,
      credentialId,
      config: { webhookSecretCredentialId: credentialId },
    });
    return {
      adapter,
      // Webhook adapters don't seed/simulate — those are
      // polling-only operations. Provide no-op stubs.
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
// Binding-config schema
// ---------------------------------------------------------------------------

describe("source-fireflies — binding-config schema", () => {
  it("requires webhookSecretCredentialId", () => {
    expect(() => firefliesBindingConfigSchema.parse({})).toThrow();
  });

  it("defaults reviewMode to 'approve' (THREAT-MODEL §3.1 — meeting transcripts ship review-required)", () => {
    const parsed = firefliesBindingConfigSchema.parse({
      webhookSecretCredentialId: "uuid",
    });
    expect(parsed.reviewMode).toBe("approve");
  });

  it("accepts the full reviewMode enum (auto / approve / review)", () => {
    for (const mode of ["auto", "approve", "review"] as const) {
      expect(
        firefliesBindingConfigSchema.parse({
          webhookSecretCredentialId: "uuid",
          reviewMode: mode,
        }).reviewMode,
      ).toBe(mode);
    }
  });

  it("defaults meetingTitleAllowlist to []", () => {
    const parsed = firefliesBindingConfigSchema.parse({
      webhookSecretCredentialId: "uuid",
    });
    expect(parsed.meetingTitleAllowlist).toEqual([]);
  });

  it("accepts meetingTitleAllowlist as a string array", () => {
    const parsed = firefliesBindingConfigSchema.parse({
      webhookSecretCredentialId: "uuid",
      meetingTitleAllowlist: ["weekly", "Quarterly Review"],
    });
    expect(parsed.meetingTitleAllowlist).toEqual([
      "weekly",
      "Quarterly Review",
    ]);
  });

  it("rejects unknown top-level fields (.strict)", () => {
    expect(() =>
      firefliesBindingConfigSchema.parse({
        webhookSecretCredentialId: "uuid",
        ghost: "no",
      }),
    ).toThrow();
  });

  it("rejects empty webhookSecretCredentialId", () => {
    expect(() =>
      firefliesBindingConfigSchema.parse({ webhookSecretCredentialId: "" }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Adapter wiring
// ---------------------------------------------------------------------------

describe("source-fireflies — adapter wiring", () => {
  it("slug is 'fireflies'", async () => {
    const { adapter } = await makeFixture({ secret: fixture.secret });
    expect(adapter.slug).toBe(FIREFLIES_ADAPTER_SLUG);
    expect(adapter.slug).toBe("fireflies");
  });

  it("scan() is a no-op (webhook mode — receiver pushes events)", async () => {
    const { adapter } = await makeFixture({ secret: fixture.secret });
    const result = await adapter.scan({ cursor: null });
    expect(result.documents).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("scan() returns no-op even when cursor is non-null", async () => {
    const { adapter } = await makeFixture({ secret: fixture.secret });
    const result = await adapter.scan({ cursor: "anything" });
    expect(result.documents).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("invalid binding config throws at factory time, not later", async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedSecret(store, fixture.secret);
    expect(() =>
      createFirefliesSourceAdapter({
        credentialStore: store,
        credentialId,
        config: {},
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Signature extraction
// ---------------------------------------------------------------------------

describe("source-fireflies — signature extraction", () => {
  it("matches case-insensitively (X-Fireflies-Signature, x-fireflies-signature)", () => {
    expect(
      extractFirefliesSignature({
        "X-Fireflies-Signature": "abc",
      }),
    ).toBe("abc");
    expect(
      extractFirefliesSignature({
        "x-fireflies-signature": "def",
      }),
    ).toBe("def");
    expect(extractFirefliesSignature({})).toBeUndefined();
  });

  it("ignores other headers", () => {
    expect(
      extractFirefliesSignature({
        "x-hub-signature-256": "wrong-header",
        "x-hook-signature": "also-wrong",
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseEvents — single-event envelope, eventId fallback,
//                meetingTitleAllowlist, ceiling, sourceRef shape
// ---------------------------------------------------------------------------

describe("source-fireflies — webhook helpers", () => {
  it("parseEvents returns exactly one event for a single-meeting envelope", () => {
    const helpers = buildFirefliesWebhookHelpers();
    const events = helpers.parseEvents({ body: fixture.body });
    expect(events).toHaveLength(1);
  });

  it("parseEvents emits sourceRef in the form 'fireflies:meeting/<meetingId>' (NOT transcriptId)", () => {
    const helpers = buildFirefliesWebhookHelpers();
    const events = helpers.parseEvents({ body: fixture.body });
    expect(events[0]?.doc.sourceRef).toBe("fireflies:meeting/meeting-123");
  });

  it("parseEvents uses meetingId as sourceDocId (so revisions of the same meeting share an intake prefix)", () => {
    const helpers = buildFirefliesWebhookHelpers();
    const events = helpers.parseEvents({ body: fixture.body });
    expect(events[0]?.doc.sourceDocId).toBe("meeting-123");
  });

  it("parseEvents derives stable eventIds (replays produce the same id)", () => {
    const helpers = buildFirefliesWebhookHelpers();
    const a = helpers.parseEvents({ body: fixture.body });
    const b = helpers.parseEvents({ body: fixture.body });
    expect(a[0]?.eventId).toBe(b[0]?.eventId);
    expect(typeof a[0]?.eventId).toBe("string");
    expect((a[0]?.eventId ?? "").length).toBeGreaterThan(0);
  });

  it("eventId revision-fallback: missing `revision` → eventId derived from transcriptId (does not throw)", () => {
    const noRevisionBody = buildMockFirefliesWebhookFixture({
      meetingId: "meeting-xyz",
      revision: undefined,
      transcriptId: "tx-xyz-1",
    });
    const helpers = buildFirefliesWebhookHelpers();
    const events = helpers.parseEvents({ body: noRevisionBody.body });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventId.length).toBeGreaterThan(0);
  });

  it("eventId differs across revisions of the same meeting (replay-stable + change-detecting)", () => {
    const a = buildMockFirefliesWebhookFixture({
      meetingId: "m-1",
      revision: "rev-1",
    });
    const b = buildMockFirefliesWebhookFixture({
      meetingId: "m-1",
      revision: "rev-2",
    });
    const helpers = buildFirefliesWebhookHelpers();
    const eventA = helpers.parseEvents({ body: a.body })[0];
    const eventB = helpers.parseEvents({ body: b.body })[0];
    expect(eventA?.eventId).not.toBe(eventB?.eventId);
    // Same meetingId though.
    expect(eventA?.doc.sourceDocId).toBe(eventB?.doc.sourceDocId);
  });

  it("parseEvents preserves the full transcript (speakers + timestamps + metadata) verbatim in contentBytes", () => {
    const fx = buildMockFirefliesWebhookFixture({
      meetingId: "m-2",
      transcript:
        "Alice 00:00:01: Hello.\nBob 00:00:05: Hi.\nMETADATA: project=acme",
      title: "Daily Sync",
    });
    const helpers = buildFirefliesWebhookHelpers();
    const events = helpers.parseEvents({ body: fx.body });
    const utf8 = events[0]?.doc.contentBytes.toString("utf8") ?? "";
    expect(utf8).toContain("Alice 00:00:01: Hello.");
    expect(utf8).toContain("Bob 00:00:05: Hi.");
    expect(utf8).toContain("METADATA: project=acme");
    expect(utf8).toContain("Daily Sync");
  });

  it("parseEvents throws on malformed JSON body", () => {
    const helpers = buildFirefliesWebhookHelpers();
    expect(() =>
      helpers.parseEvents({ body: Buffer.from("{not json", "utf8") }),
    ).toThrow();
  });

  it("parseEvents throws on non-object root", () => {
    const helpers = buildFirefliesWebhookHelpers();
    expect(() =>
      helpers.parseEvents({ body: Buffer.from('"a string"', "utf8") }),
    ).toThrow();
  });

  it("parseEvents throws when required fields are missing (meetingId / transcript / action / title)", () => {
    const helpers = buildFirefliesWebhookHelpers();
    const missing = Buffer.from(JSON.stringify({}), "utf8");
    expect(() => helpers.parseEvents({ body: missing })).toThrow();
  });

  it("parseEvents throws when title is an empty string (Copilot triage — allowlist requires non-empty title)", () => {
    const helpers = buildFirefliesWebhookHelpers();
    const fx = buildMockFirefliesWebhookFixture({ title: "" });
    expect(() => helpers.parseEvents({ body: fx.body })).toThrow(
      /missing required fields|non-empty title/,
    );
  });

  it("parseEvents throws when BOTH revision and transcriptId are absent (Copilot triage — eventId collision-prone)", () => {
    const helpers = buildFirefliesWebhookHelpers();
    // Build a body without revision AND without transcriptId.
    // The mock fixture defaults to providing both; we override
    // by constructing the body manually.
    const body = Buffer.from(
      JSON.stringify({
        meetingId: "m-1",
        action: "transcript.completed",
        transcript: "Speaker: Hello",
        title: "Standup",
      }),
      "utf8",
    );
    expect(() => helpers.parseEvents({ body })).toThrow(
      /at least one of \{revision, transcriptId\}/,
    );
  });

  it("parseEvents enforces the 1 MiB ceiling on contentBytes", () => {
    const fx = buildMockFirefliesWebhookFixture({
      meetingId: "m-fat",
      transcript: "x".repeat(2 * 1024 * 1024),
    });
    const helpers = buildFirefliesWebhookHelpers();
    expect(() => helpers.parseEvents({ body: fx.body })).toThrow();
  });

  it("verifier rejects sha256= prefix when signature is wrong (negative)", () => {
    const helpers = buildFirefliesWebhookHelpers();
    const result = helpers.verifier.verify({
      body: fixture.body,
      secret: fixture.secret,
      signature: "sha256=" + "00".repeat(32),
    });
    expect(result.ok).toBe(false);
  });

  it("verifier accepts the valid signature emitted by the mock fixture", () => {
    const helpers = buildFirefliesWebhookHelpers();
    const result = helpers.verifier.verify({
      body: fixture.body,
      secret: fixture.secret,
      signature: fixture.validSignature,
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// meetingTitleAllowlist — operator scope filter
// ---------------------------------------------------------------------------

describe("source-fireflies — meetingTitleAllowlist (operator scope filter)", () => {
  it("default empty allowlist → ingest all meetings", () => {
    const helpers = buildFirefliesWebhookHelpers({ meetingTitleAllowlist: [] });
    const events = helpers.parseEvents({ body: fixture.body });
    expect(events).toHaveLength(1);
  });

  it("allowlist match (case-insensitive substring) → ingest", () => {
    const fx = buildMockFirefliesWebhookFixture({
      meetingId: "m-w",
      title: "Weekly Standup",
    });
    const helpers = buildFirefliesWebhookHelpers({
      meetingTitleAllowlist: ["weekly"],
    });
    const events = helpers.parseEvents({ body: fx.body });
    expect(events).toHaveLength(1);
  });

  it("allowlist no-match → drop (returns empty array, does not throw)", () => {
    const fx = buildMockFirefliesWebhookFixture({
      meetingId: "m-priv",
      title: "Private 1:1",
    });
    const helpers = buildFirefliesWebhookHelpers({
      meetingTitleAllowlist: ["weekly", "quarterly"],
    });
    const events = helpers.parseEvents({ body: fx.body });
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Credentials sourcing pin (THREAT-MODEL §3.6 invariant 11)
// ---------------------------------------------------------------------------

describe("source-fireflies — credentials sourcing (THREAT-MODEL §3.6 invariant 11)", () => {
  it("factory rejects inline credential strings at the type level", () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const fakeInline = { token: "y" };
    // @ts-expect-error — invariant 11: no inline credentials accepted.
    void (() =>
      createFirefliesSourceAdapter({
        credentialStore: store,
        config: { webhookSecretCredentialId: "uuid" },
        creds: fakeInline,
      }));
    expect(typeof store.read).toBe("function");
  });
});

/**
 * source-asana adapter tests (PR 24 / plan #115).
 *
 * Layers:
 *   1. Shared `sourceAdapterContract({ mode: 'webhook' })` —
 *      runs the 5 webhook assertions against the adapter +
 *      the buildMockAsanaWebhookFixture helper. This exercises
 *      the verifier + extractSignature + parseEvents path
 *      end-to-end.
 *   2. Adapter-specific tests covering binding-config Zod
 *      validation, signature extraction case-insensitivity,
 *      synthetic eventId stability, malformed-body rejection.
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
  ASANA_ADAPTER_SLUG,
  ASANA_SIGNATURE_HEADER,
  asanaBindingConfigSchema,
  buildAsanaWebhookHelpers,
  createAsanaSourceAdapter,
  extractAsanaSignature,
} from "../src/index.js";
import { buildMockAsanaWebhookFixture } from "../src/testing/mock-asana-events.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

async function seedSecret(
  store: CredentialStore,
  bytes: Buffer,
): Promise<CredentialId> {
  return store.write({
    name: "asana-test-webhook-secret",
    schemaRef: "asana-webhook-secret/v1",
    plaintext: bytes,
  });
}

interface MakeFixtureOptions {
  /** Override the binding-config — defaults to the canonical
   *  `{ projectGid, webhookSecretCredentialId }` minimum. */
  readonly config?: Record<string, unknown>;
  /** Bytes to seed as the webhook secret. Defaults to the
   *  shared corpus fixture's secret. */
  readonly secret?: Buffer;
}

async function makeFixture(
  opts: MakeFixtureOptions = {},
): Promise<{
  readonly store: CredentialStore;
  readonly credentialId: CredentialId;
  readonly adapter: ReturnType<typeof createAsanaSourceAdapter>;
}> {
  const store = new InMemoryCredentialStore({ logger: silentLogger() });
  const credentialId = await seedSecret(
    store,
    opts.secret ?? Buffer.from("asana-test-secret"),
  );
  const adapter = createAsanaSourceAdapter({
    credentialStore: store,
    credentialId,
    config:
      opts.config ?? {
        projectGid: "p",
        webhookSecretCredentialId: credentialId,
      },
  });
  return { store, credentialId, adapter };
}

// ---------------------------------------------------------------------------
// Shared sourceAdapterContract — webhook mode
// ---------------------------------------------------------------------------

const fixture = buildMockAsanaWebhookFixture();

sourceAdapterContract({
  backendName: "source-asana",
  mode: "webhook",
  webhookFixture: {
    body: fixture.body,
    secret: fixture.secret,
    validSignature: fixture.validSignature,
    headers: fixture.headers,
    signatureHeaderName: ASANA_SIGNATURE_HEADER,
  },
  makeAdapter: async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedSecret(store, fixture.secret);
    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: "1214005588882595",
        webhookSecretCredentialId: credentialId,
      },
    });
    return {
      adapter,
      // The webhook adapter doesn't seed/simulate — those are
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
// Adapter-specific tests
// ---------------------------------------------------------------------------

describe("source-asana — binding-config schema", () => {
  it("requires projectGid + webhookSecretCredentialId", () => {
    expect(() =>
      asanaBindingConfigSchema.parse({
        webhookSecretCredentialId: "uuid",
      }),
    ).toThrow();
    expect(() =>
      asanaBindingConfigSchema.parse({ projectGid: "p" }),
    ).toThrow();
  });

  it("defaults reviewMode to 'auto'", () => {
    const parsed = asanaBindingConfigSchema.parse({
      projectGid: "p",
      webhookSecretCredentialId: "uuid",
    });
    expect(parsed.reviewMode).toBe("auto");
  });

  it("rejects unknown top-level fields (.strict)", () => {
    expect(() =>
      asanaBindingConfigSchema.parse({
        projectGid: "p",
        webhookSecretCredentialId: "uuid",
        ghost: "no",
      }),
    ).toThrow();
  });
});

describe("source-asana — adapter wiring", () => {
  it("slug is 'asana'", async () => {
    const { adapter } = await makeFixture({ secret: fixture.secret });
    expect(adapter.slug).toBe(ASANA_ADAPTER_SLUG);
    expect(adapter.slug).toBe("asana");
  });

  it("scan() is a no-op (webhook mode — receiver pushes events)", async () => {
    const { adapter } = await makeFixture({ secret: fixture.secret });
    const result = await adapter.scan({ cursor: null });
    expect(result.documents).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("invalid binding config throws at factory time, not later", async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedSecret(store, fixture.secret);
    expect(() =>
      createAsanaSourceAdapter({
        credentialStore: store,
        credentialId,
        config: {},
      }),
    ).toThrow();
  });
});

describe("source-asana — signature extraction", () => {
  it("matches case-insensitively (X-Hook-Signature, x-hook-signature)", () => {
    expect(
      extractAsanaSignature({
        "X-Hook-Signature": "abc",
      }),
    ).toBe("abc");
    expect(
      extractAsanaSignature({
        "x-hook-signature": "def",
      }),
    ).toBe("def");
    expect(extractAsanaSignature({})).toBeUndefined();
    // Other headers ignored.
    expect(
      extractAsanaSignature({
        "x-hook-secret": "wrong-header",
      }),
    ).toBeUndefined();
  });
});

describe("source-asana — webhook helpers", () => {
  it("parseEvents derives stable eventIds (replays produce the same id)", () => {
    const helpers = buildAsanaWebhookHelpers();
    const first = helpers.parseEvents({ body: fixture.body });
    const second = helpers.parseEvents({ body: fixture.body });
    expect(first.length).toBe(1);
    expect(second.map((e) => e.eventId)).toEqual(
      first.map((e) => e.eventId),
    );
  });

  it("parseEvents produces 1 event per Asana event in body.events[] (both events must have derivable event type)", () => {
    const multi = buildMockAsanaWebhookFixture({
      events: [
        {
          user_gid: "u1",
          resource_gid: "r1",
          resource_type: "task",
          action: "added",
          created_at: "2026-04-25T12:00:00Z",
        },
        {
          user_gid: "u2",
          resource_gid: "r2",
          resource_type: "task",
          action: "changed",
          created_at: "2026-04-25T12:01:00Z",
          // PR-F: change.field is required for 'changed' events to
          // produce a non-null eventType; 'completed' maps to 'completed'.
          change_field: "completed",
        },
      ],
    });
    const helpers = buildAsanaWebhookHelpers();
    const events = helpers.parseEvents({ body: multi.body });
    expect(events).toHaveLength(2);
    // Distinct events get distinct eventIds.
    const ids = events.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(2);
  });

  it("parseEvents emits sourceRef in the form 'asana:<resource_type>/<gid>'", () => {
    const helpers = buildAsanaWebhookHelpers();
    const events = helpers.parseEvents({ body: fixture.body });
    expect(events[0]?.doc.sourceRef).toBe("asana:task/task-42");
  });

  it("parseEvents throws on malformed JSON body", () => {
    const helpers = buildAsanaWebhookHelpers();
    expect(() =>
      helpers.parseEvents({ body: Buffer.from("{not json", "utf8") }),
    ).toThrow();
  });

  it("parseEvents throws on non-object root", () => {
    const helpers = buildAsanaWebhookHelpers();
    expect(() =>
      helpers.parseEvents({ body: Buffer.from('"a string"', "utf8") }),
    ).toThrow();
  });

  it("parseEvents on empty events[] returns []", () => {
    const empty = Buffer.from(JSON.stringify({ events: [] }), "utf8");
    const helpers = buildAsanaWebhookHelpers();
    expect(helpers.parseEvents({ body: empty })).toEqual([]);
  });

  it("verifier rejects sha256= prefix when signature is wrong (negative)", () => {
    const helpers = buildAsanaWebhookHelpers();
    const result = helpers.verifier.verify({
      body: fixture.body,
      secret: fixture.secret,
      signature: "sha256=" + "00".repeat(32),
    });
    expect(result.ok).toBe(false);
  });
});

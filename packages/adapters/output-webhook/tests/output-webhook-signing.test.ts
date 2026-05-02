/**
 * output-webhook signing tests (PR-J / phase-a appendix #4).
 *
 * Verifies:
 *   1. Outgoing requests carry `X-OpenCoo-Signature: <hex>`
 *      HMAC-SHA256 over the raw body bytes using the signing secret.
 *   2. `X-OpenCoo-Delivery-Id: <uuid>` is present for receiver-side
 *      idempotency — deterministic from (binding_id, payload_hash) so
 *      replay attempts carry the same delivery ID.
 *   3. The delivery ID is a valid UUID format.
 *   4. Replaying the same payload to the same binding produces the
 *      same delivery ID (deterministic).
 *   5. Different payloads produce different delivery IDs.
 *
 * THREAT-MODEL §3.6 invariant 11: error messages NEVER carry signing
 * secret bytes. The signing secret is only resolved from CredentialStore
 * inside the adapter; these tests assert the actual HMAC is correct.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createWebhookOutputAdapter } from "../src/index.js";
import {
  createMockHttpState,
  makeMockHttpFetch,
} from "../src/testing/mock-http.js";
import { VALID_PAYLOAD, createTestStore } from "./test-helpers.js";

const SIGNING_SECRET = "test-signing-secret-for-hmac-verification";

async function makeAdapterAndStore() {
  const httpState = createMockHttpState();
  const store = createTestStore();
  const credentialId = await store.write({
    name: "signing-secret",
    schemaRef: "webhook-signing-secret/v1",
    plaintext: Buffer.from(SIGNING_SECRET),
  });
  const adapter = createWebhookOutputAdapter({
    config: {
      targetUrl: "https://example.com/hooks/opencoo",
      signingSecretCredentialId: credentialId as string,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
      headers: {},
    },
    makeFetch: () => makeMockHttpFetch(httpState),
  });
  return { adapter, store, credentialId, httpState };
}

// UUID v4/v5 format: 8-4-4-4-12 hex groups
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("output-webhook — signing", () => {
  it("outgoing request carries X-OpenCoo-Signature as HMAC-SHA256 hex over the body", async () => {
    const { adapter, store, credentialId, httpState } =
      await makeAdapterAndStore();

    await adapter.write({
      credentialStore: store,
      credentialId,
      payload: VALID_PAYLOAD,
    });

    expect(httpState.lastRequest).toBeDefined();
    const req = httpState.lastRequest!;
    expect(req.headers["x-opencoo-signature"]).toBeDefined();

    // Verify the HMAC is correct: compute expected from body bytes
    const bodyBytes = Buffer.from(req.body, "utf8");
    const expectedHmac = createHmac("sha256", SIGNING_SECRET)
      .update(bodyBytes)
      .digest("hex");

    expect(req.headers["x-opencoo-signature"]).toBe(expectedHmac);
  });

  it("outgoing request carries X-OpenCoo-Delivery-Id as a valid UUID", async () => {
    const { adapter, store, credentialId, httpState } =
      await makeAdapterAndStore();

    await adapter.write({
      credentialStore: store,
      credentialId,
      payload: VALID_PAYLOAD,
    });

    const req = httpState.lastRequest!;
    expect(req.headers["x-opencoo-delivery-id"]).toBeDefined();
    expect(req.headers["x-opencoo-delivery-id"]).toMatch(UUID_RE);
  });

  it("delivery ID is deterministic — same payload produces same delivery ID across calls", async () => {
    const { adapter, store, credentialId, httpState } =
      await makeAdapterAndStore();

    await adapter.write({ credentialStore: store, credentialId, payload: VALID_PAYLOAD });
    const id1 = httpState.lastRequest!.headers["x-opencoo-delivery-id"];

    // Reset calls and send again with same payload
    httpState.calls.length = 0;
    await adapter.write({ credentialStore: store, credentialId, payload: VALID_PAYLOAD });
    const id2 = httpState.lastRequest!.headers["x-opencoo-delivery-id"];

    expect(id1).toBe(id2);
  });

  it("different payloads produce different delivery IDs", async () => {
    const { adapter, store, credentialId, httpState } =
      await makeAdapterAndStore();

    await adapter.write({
      credentialStore: store,
      credentialId,
      payload: { event: "heartbeat.report", data: { summary: "a" } },
    });
    const id1 = httpState.lastRequest!.headers["x-opencoo-delivery-id"];

    httpState.calls.length = 0;
    await adapter.write({
      credentialStore: store,
      credentialId,
      payload: { event: "heartbeat.report", data: { summary: "b" } },
    });
    const id2 = httpState.lastRequest!.headers["x-opencoo-delivery-id"];

    expect(id1).not.toBe(id2);
  });

  it("X-OpenCoo-Signature is 64 hex characters (SHA-256 output)", async () => {
    const { adapter, store, credentialId, httpState } =
      await makeAdapterAndStore();

    await adapter.write({ credentialStore: store, credentialId, payload: VALID_PAYLOAD });

    const sig = httpState.lastRequest!.headers["x-opencoo-signature"];
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });
});

/**
 * output-webhook contract test (PR-J / phase-a appendix #4).
 *
 * Runs the shared 9-assertion `outputAdapterContract` suite
 * against the output-webhook adapter wired with an in-memory
 * mock HTTP client.
 *
 * The mock programmatic upstream plugs into the fetch-like
 * interface the adapter delegates HTTP calls through.
 */
import { outputAdapterContract } from "@opencoo/shared/adapter-contract-tests/output-adapter";

import {
  WEBHOOK_OUTPUT_ADAPTER_SLUG,
  createWebhookOutputAdapter,
  type WebhookPayload,
} from "../src/index.js";
import {
  createMockHttpState,
  makeMockHttpFetch,
} from "../src/testing/mock-http.js";
import { VALID_PAYLOAD, createTestStore } from "./test-helpers.js";

const CONTRACT_SECRET_MARKER = "webhook_contract_secret_marker_xyz_abc";

outputAdapterContract<WebhookPayload>({
  backendName: "output-webhook",
  makeAdapter: async () => {
    const httpState = createMockHttpState();
    const store = createTestStore();

    // Seed the signing secret credential
    const signingSecretCredentialId = await store.write({
      name: "webhook-signing-secret",
      schemaRef: "webhook-signing-secret/v1",
      plaintext: Buffer.from(CONTRACT_SECRET_MARKER),
    });

    const adapter = createWebhookOutputAdapter({
      config: {
        targetUrl: "https://example.com/hooks/opencoo",
        signingSecretCredentialId: signingSecretCredentialId as string,
        retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
        headers: {},
      },
      makeFetch: () => makeMockHttpFetch(httpState),
    });

    return {
      adapter,
      credentialStore: store,
      credentialId: signingSecretCredentialId,
      secretMarker: CONTRACT_SECRET_MARKER,
      validPayload: VALID_PAYLOAD,
      overKeyedPayload: {
        ...VALID_PAYLOAD,
        // @ts-expect-error — this extra key violates the strict schema
        __smuggled: "agent-injected-field",
      } as WebhookPayload,
      programUpstream: (behavior) => {
        if (behavior.kind === "ok") {
          httpState.behavior = { kind: "ok" };
        } else if (behavior.kind === "http-error") {
          httpState.behavior = {
            kind: "http-error",
            status: behavior.status,
            ...(behavior.retryAfterSeconds !== undefined
              ? { retryAfterSeconds: behavior.retryAfterSeconds }
              : {}),
          };
        } else {
          httpState.behavior = { kind: "transient" };
        }
      },
      inspectCalls: () => httpState.calls.map((c) => ({ payload: c })),
      cleanup: async () => undefined,
    };
  },
});

// Slug sanity
import { describe, expect, it } from "vitest";
describe("output-webhook slug", () => {
  it("slug is 'webhook'", async () => {
    const httpState = createMockHttpState();
    const store = createTestStore();
    const credId = await store.write({
      name: "s",
      schemaRef: "s/v1",
      plaintext: Buffer.from("secret"),
    });
    const adapter = createWebhookOutputAdapter({
      config: {
        targetUrl: "https://example.com/hooks/opencoo",
        signingSecretCredentialId: credId as string,
        retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
        headers: {},
      },
      makeFetch: () => makeMockHttpFetch(httpState),
    });
    expect(adapter.slug).toBe(WEBHOOK_OUTPUT_ADAPTER_SLUG);
    expect(adapter.slug).toBe("webhook");
  });
});

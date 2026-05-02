/**
 * output-webhook — THREAT-MODEL §3.6 invariant 11 tests (PR-J).
 *
 * Invariant 11: credential bytes NEVER appear in any outgoing request
 * body, headers, or error messages. The signing secret is used ONLY
 * to compute the HMAC signature; it must not be serialised into the
 * payload body or echoed back in any observable output.
 *
 * Assertions:
 *   1. The signing secret never appears in the outgoing request body.
 *   2. The signing secret never appears in any custom headers value.
 *   3. The signing secret never appears as the value of any standard
 *      header (only as the computed HMAC, not the raw bytes).
 *   4. An error thrown by the adapter never contains the raw signing
 *      secret bytes.
 *   5. The `Authorization` header is rejected at config-validate time
 *      (case-insensitive) — credentials route through signing-secret
 *      only. This is the `headers` config guard.
 */
import { describe, expect, it } from "vitest";

import { OutputAdapterValidationError } from "@opencoo/shared/output-adapter";
import { createWebhookOutputAdapter } from "../src/index.js";
import {
  createMockHttpState,
  makeMockHttpFetch,
} from "../src/testing/mock-http.js";
import { VALID_PAYLOAD, createTestStore } from "./test-helpers.js";

// A highly distinctive secret that would be unmistakeable in any output
const DISTINCTIVE_SECRET =
  "unique_secret_value_that_must_never_appear_in_any_outbound_payload_or_header";

async function makeAdapter(opts: { headers?: Record<string, string> } = {}) {
  const httpState = createMockHttpState();
  const store = createTestStore();
  const credentialId = await store.write({
    name: "signing-secret",
    schemaRef: "webhook-signing-secret/v1",
    plaintext: Buffer.from(DISTINCTIVE_SECRET),
  });

  const adapter = createWebhookOutputAdapter({
    config: {
      targetUrl: "https://example.com/hooks/opencoo",
      signingSecretCredentialId: credentialId as string,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
      headers: opts.headers ?? {},
    },
    makeFetch: () => makeMockHttpFetch(httpState),
  });

  return { adapter, store, credentialId, httpState };
}

describe("output-webhook — no credentials in payload (THREAT-MODEL §3.6 invariant 11)", () => {
  it("signing secret bytes never appear in the outgoing request body", async () => {
    const { adapter, store, credentialId, httpState } = await makeAdapter();

    await adapter.write({ credentialStore: store, credentialId, payload: VALID_PAYLOAD });

    expect(httpState.lastRequest).toBeDefined();
    const body = httpState.lastRequest!.body;
    expect(body).not.toContain(DISTINCTIVE_SECRET);
  });

  it("signing secret bytes never appear in any request header value", async () => {
    const { adapter, store, credentialId, httpState } = await makeAdapter();

    await adapter.write({ credentialStore: store, credentialId, payload: VALID_PAYLOAD });

    const headers = httpState.lastRequest!.headers;
    for (const [headerName, headerValue] of Object.entries(headers)) {
      expect(
        headerValue,
        `header '${headerName}' must not contain signing secret`,
      ).not.toContain(DISTINCTIVE_SECRET);
    }
  });

  it("error message when upstream fails never contains signing secret", async () => {
    const httpState = createMockHttpState();
    const store = createTestStore();
    const credentialId = await store.write({
      name: "signing-secret",
      schemaRef: "webhook-signing-secret/v1",
      plaintext: Buffer.from(DISTINCTIVE_SECRET),
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

    httpState.behavior = { kind: "http-error", status: 503 };

    try {
      await adapter.write({
        credentialStore: store,
        credentialId,
        payload: VALID_PAYLOAD,
      });
      throw new Error("expected throw");
    } catch (err) {
      const errMsg =
        err instanceof Error ? err.message : String(err);
      expect(errMsg).not.toContain(DISTINCTIVE_SECRET);
    }
  });

  it("'Authorization' header in config is rejected at create time (case: exact)", () => {
    expect(() =>
      createWebhookOutputAdapter({
        config: {
          targetUrl: "https://example.com/hooks/opencoo",
          signingSecretCredentialId: "some-id",
          retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
          headers: { Authorization: "Bearer my-secret-token" },
        },
        makeFetch: () => makeMockHttpFetch(createMockHttpState()),
      }),
    ).toThrow(/authorization/i);
  });

  it("'authorization' header in config is rejected (case-insensitive)", () => {
    expect(() =>
      createWebhookOutputAdapter({
        config: {
          targetUrl: "https://example.com/hooks/opencoo",
          signingSecretCredentialId: "some-id",
          retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
          headers: { authorization: "Bearer my-secret-token" },
        },
        makeFetch: () => makeMockHttpFetch(createMockHttpState()),
      }),
    ).toThrow(/authorization/i);
  });

  it("'AUTHORIZATION' header in config is rejected (uppercase)", () => {
    expect(() =>
      createWebhookOutputAdapter({
        config: {
          targetUrl: "https://example.com/hooks/opencoo",
          signingSecretCredentialId: "some-id",
          retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
          headers: { AUTHORIZATION: "Bearer my-secret-token" },
        },
        makeFetch: () => makeMockHttpFetch(createMockHttpState()),
      }),
    ).toThrow(/authorization/i);
  });

  it("custom non-Authorization headers are permitted", async () => {
    const httpState = createMockHttpState();
    const store = createTestStore();
    const credentialId = await store.write({
      name: "s",
      schemaRef: "s/v1",
      plaintext: Buffer.from("safe-secret"),
    });

    expect(() =>
      createWebhookOutputAdapter({
        config: {
          targetUrl: "https://example.com/hooks/opencoo",
          signingSecretCredentialId: credentialId as string,
          retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
          headers: {
            "X-Custom-Header": "custom-value",
            "Content-Type": "application/json",
          },
        },
        makeFetch: () => makeMockHttpFetch(httpState),
      }),
    ).not.toThrow();
  });

  it("payload body does not contain externalId or externalUrl that embeds signing secret", async () => {
    const { adapter, store, credentialId } = await makeAdapter();

    const result = await adapter.write({
      credentialStore: store,
      credentialId,
      payload: VALID_PAYLOAD,
    });

    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain(DISTINCTIVE_SECRET);
  });
});

describe("output-webhook — 1 MiB payload ceiling", () => {
  it("payload over 1 MiB throws OutputAdapterValidationError before any HTTP call", async () => {
    const httpState = createMockHttpState();
    const store = createTestStore();
    const credentialId = await store.write({
      name: "signing-secret",
      schemaRef: "webhook-signing-secret/v1",
      plaintext: Buffer.from("test-secret"),
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

    // Build a payload whose JSON serialization exceeds 1 MiB (~1.1 MiB)
    // "x" * 1_150_000 bytes in a string field far exceeds the cap once JSON-encoded.
    const oversizedPayload = {
      event: "heartbeat.report",
      data: { big: "x".repeat(1_150_000) },
    };

    await expect(
      adapter.write({ credentialStore: store, credentialId, payload: oversizedPayload }),
    ).rejects.toThrow(OutputAdapterValidationError);

    await expect(
      adapter.write({ credentialStore: store, credentialId, payload: oversizedPayload }),
    ).rejects.toThrow(/exceeds 1 MiB ceiling/);

    // No HTTP calls should have been made — we throw before sending
    expect(httpState.calls).toHaveLength(0);
  });

  it("payload just under 1 MiB is accepted and sent normally", async () => {
    const httpState = createMockHttpState();
    const store = createTestStore();
    const credentialId = await store.write({
      name: "signing-secret",
      schemaRef: "webhook-signing-secret/v1",
      plaintext: Buffer.from("test-secret"),
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

    // Payload just under 1 MiB — enough to verify the boundary allows it.
    // JSON envelope overhead for this shape is ~40 bytes, so 1_048_500 chars
    // in the field would exceed the cap. Use 1_000_000 chars to stay safely
    // under 1_048_576 bytes after JSON serialization.
    const justUnPayload = {
      event: "heartbeat.report",
      data: { big: "x".repeat(1_000_000) },
    };

    await expect(
      adapter.write({ credentialStore: store, credentialId, payload: justUnPayload }),
    ).resolves.toBeDefined();

    expect(httpState.calls).toHaveLength(1);
  });
});

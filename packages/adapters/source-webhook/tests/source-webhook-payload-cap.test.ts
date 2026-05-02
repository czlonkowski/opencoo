/**
 * 1 MiB payload ceiling tests for source-webhook (PR-I).
 *
 * Mirrors the source-asana payload cap pattern.
 * Asserts:
 * - Payloads ≤ 1 MiB pass through
 * - Payloads > 1 MiB throw ValidationError (fail-closed)
 * - ValidationError message does NOT include signing-secret bytes
 *   (THREAT-MODEL §3.6 invariant 11)
 */
import { describe, expect, it } from "vitest";

import { ValidationError } from "@opencoo/shared/errors";

import { buildWebhookHelpers } from "../src/adapter.js";
import { buildOversizedPayload, buildMockWebhookPayload } from "./testing/mock-webhook-payloads.js";

const ONE_MIB = 1024 * 1024;

describe("source-webhook — 1 MiB payload ceiling", () => {
  it("accepts a payload within 1 MiB", () => {
    const fixture = buildMockWebhookPayload();
    const helpers = buildWebhookHelpers({
      signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
      eventIdField: "$.event.id",
    });
    // The fixture payload is tiny — must not throw.
    const events = helpers.parseEvents({ body: fixture.body });
    expect(events.length).toBe(1);
    expect(events[0]!.doc.contentBytes.length).toBeLessThanOrEqual(ONE_MIB);
  });

  it("throws ValidationError for a payload exceeding 1 MiB (fail-closed)", () => {
    const secret = Buffer.from("oversize-secret");
    const oversized = buildOversizedPayload(secret);
    const helpers = buildWebhookHelpers({
      signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
      eventIdField: "$.event.id",
    });
    expect(() =>
      helpers.parseEvents({ body: oversized.body }),
    ).toThrow(ValidationError);
  });

  it("ValidationError message does NOT contain signing-secret bytes (THREAT-MODEL §3.6 inv. 11)", () => {
    const secretValue = "secret-bytes-that-must-not-leak";
    const secret = Buffer.from(secretValue);
    const oversized = buildOversizedPayload(secret);
    const helpers = buildWebhookHelpers({
      signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
      eventIdField: "$.event.id",
    });
    let caughtMessage = "";
    try {
      helpers.parseEvents({ body: oversized.body });
    } catch (e) {
      caughtMessage = e instanceof Error ? e.message : String(e);
    }
    // Error message must not contain the secret bytes.
    expect(caughtMessage).not.toContain(secretValue);
  });

  it("ValidationError message does NOT contain raw payload bytes", () => {
    const oversized = buildOversizedPayload();
    const helpers = buildWebhookHelpers({
      signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
      eventIdField: "$.event.id",
    });
    let caughtMessage = "";
    try {
      helpers.parseEvents({ body: oversized.body });
    } catch (e) {
      caughtMessage = e instanceof Error ? e.message : String(e);
    }
    // The error message must be short (not embed the payload body).
    // 300 chars is a generous ceiling for a descriptive error.
    expect(caughtMessage.length).toBeLessThan(300);
  });
});

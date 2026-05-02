/**
 * HMAC + replay-stable event_id derivation tests for source-webhook (PR-I).
 *
 * THREAT-MODEL §3.1: HMAC + replay.
 * Asserts:
 * - event_id extracted via jsonpath from eventIdField is stable across replays
 * - same payload body → same eventId every time
 * - extraction failure on missing path → throws ValidationError (fail-closed)
 * - sourceRevision equals eventId (each event = one revision)
 * - sourceDocId is the event_id
 * - extraction works for nested paths: $.payload.event_id
 */
import { describe, expect, it } from "vitest";

import { ValidationError } from "@opencoo/shared/errors";

import {
  buildWebhookHelpers,
  WEBHOOK_ADAPTER_SLUG,
} from "../src/adapter.js";
import { buildMockWebhookPayload, buildMockWebhookPayloadNested } from "./testing/mock-webhook-payloads.js";

describe("source-webhook — HMAC verification", () => {
  it("verifier.verify returns ok=true for correct body+signature", () => {
    const fixture = buildMockWebhookPayload();
    const helpers = buildWebhookHelpers({
      signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
      eventIdField: "$.event.id",
    });
    const result = helpers.verifier.verify({
      body: fixture.body,
      secret: fixture.secret,
      signature: fixture.validSignature,
    });
    expect(result.ok).toBe(true);
  });

  it("verifier.verify returns ok=false for missing signature", () => {
    const fixture = buildMockWebhookPayload();
    const helpers = buildWebhookHelpers({
      signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
      eventIdField: "$.event.id",
    });
    const result = helpers.verifier.verify({
      body: fixture.body,
      secret: fixture.secret,
      signature: undefined,
    });
    expect(result.ok).toBe(false);
  });

  it("verifier.verify returns ok=false for tampered signature", () => {
    const fixture = buildMockWebhookPayload();
    const helpers = buildWebhookHelpers({
      signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
      eventIdField: "$.event.id",
    });
    const tampered =
      fixture.validSignature.slice(0, -1) +
      (fixture.validSignature.slice(-1) === "0" ? "1" : "0");
    const result = helpers.verifier.verify({
      body: fixture.body,
      secret: fixture.secret,
      signature: tampered,
    });
    expect(result.ok).toBe(false);
  });
});

describe("source-webhook — event_id stability (replay safety)", () => {
  it("parseEvents produces the same eventId for the same body on repeated calls", () => {
    const fixture = buildMockWebhookPayload();
    const helpers = buildWebhookHelpers({
      signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
      eventIdField: "$.event.id",
    });
    const first = helpers.parseEvents({ body: fixture.body });
    const second = helpers.parseEvents({ body: fixture.body });
    expect(first.length).toBeGreaterThan(0);
    expect(second.map((e) => e.eventId)).toEqual(first.map((e) => e.eventId));
  });

  it("eventId equals the value extracted from eventIdField jsonpath", () => {
    const fixture = buildMockWebhookPayload();
    const helpers = buildWebhookHelpers({
      signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
      eventIdField: "$.event.id",
    });
    const events = helpers.parseEvents({ body: fixture.body });
    expect(events.length).toBe(1);
    // The event_id from the fixture payload is "evt-abc-123"
    expect(events[0]!.eventId).toBe("evt-abc-123");
  });

  it("supports nested jsonpath extraction ($.payload.event_id)", () => {
    const fixture = buildMockWebhookPayloadNested();
    const helpers = buildWebhookHelpers({
      signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
      eventIdField: "$.payload.event_id",
    });
    const events = helpers.parseEvents({ body: fixture.body });
    expect(events.length).toBe(1);
    expect(events[0]!.eventId).toBe("nested-event-id-999");
  });

  it("sourceDocId equals the event_id (event-id is the natural key)", () => {
    const fixture = buildMockWebhookPayload();
    const helpers = buildWebhookHelpers({
      signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
      eventIdField: "$.event.id",
    });
    const events = helpers.parseEvents({ body: fixture.body });
    expect(events[0]!.doc.sourceDocId).toBe("evt-abc-123");
  });

  it("sourceRevision equals the event_id (each event = one revision)", () => {
    const fixture = buildMockWebhookPayload();
    const helpers = buildWebhookHelpers({
      signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
      eventIdField: "$.event.id",
    });
    const events = helpers.parseEvents({ body: fixture.body });
    expect(events[0]!.doc.sourceRevision).toBe("evt-abc-123");
  });

  it("parseEvents throws ValidationError when eventIdField path extracts nothing (fail-closed)", () => {
    const fixture = buildMockWebhookPayload();
    const helpers = buildWebhookHelpers({
      signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
      eventIdField: "$.nonexistent.path",
    });
    expect(() => helpers.parseEvents({ body: fixture.body })).toThrow(
      ValidationError,
    );
  });

  it("parseEvents throws ValidationError when body is not valid JSON", () => {
    const helpers = buildWebhookHelpers({
      signingSecretCredentialId: "82023cbc-7e47-4a1e-80fd-aacabd5649c0",
      eventIdField: "$.event.id",
    });
    expect(() =>
      helpers.parseEvents({ body: Buffer.from("{not json}", "utf8") }),
    ).toThrow(ValidationError);
  });

  it("slug is '" + WEBHOOK_ADAPTER_SLUG + "'", () => {
    expect(WEBHOOK_ADAPTER_SLUG).toBe("webhook");
  });
});

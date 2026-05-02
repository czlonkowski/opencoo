/**
 * Binding-config Zod schema tests for source-webhook (PR-I).
 *
 * Asserts:
 * - Required fields: pathSegment, signingSecretCredentialId (deprecated), eventIdField
 * - Optional fields: contentKindMap, defaultContentKind, reviewMode
 * - reviewMode defaults to 'review' (THREAT-MODEL §3.7)
 * - .strict() rejects unknown top-level fields
 * - defaultContentKind defaults to 'document' (has a Compiler template in v0.1)
 * - signingSecretCredentialId must be a UUID (deprecated; kept for compat)
 */
import { describe, expect, it } from "vitest";

import { sourceWebhookBindingConfigSchema } from "../src/binding-config.js";

// Valid UUID for tests (Zod v4 enforces proper UUID format).
const VALID_UUID = "82023cbc-7e47-4a1e-80fd-aacabd5649c0";

const MINIMAL_VALID: Record<string, unknown> = {
  pathSegment: "my-hook",
  signingSecretCredentialId: VALID_UUID,
  eventIdField: "$.event.id",
};

describe("source-webhook binding-config schema", () => {
  it("accepts minimal valid config", () => {
    expect(() =>
      sourceWebhookBindingConfigSchema.parse(MINIMAL_VALID),
    ).not.toThrow();
  });

  it("requires pathSegment (non-empty)", () => {
    expect(() =>
      sourceWebhookBindingConfigSchema.parse({
        ...MINIMAL_VALID,
        pathSegment: "",
      }),
    ).toThrow();
    expect(() =>
      sourceWebhookBindingConfigSchema.parse({
        signingSecretCredentialId: VALID_UUID,
        eventIdField: "$.event.id",
      }),
    ).toThrow();
  });

  it("requires signingSecretCredentialId as UUID", () => {
    expect(() =>
      sourceWebhookBindingConfigSchema.parse({
        ...MINIMAL_VALID,
        signingSecretCredentialId: "not-a-uuid",
      }),
    ).toThrow();
    // Missing entirely
    expect(() =>
      sourceWebhookBindingConfigSchema.parse({
        pathSegment: "hook",
        eventIdField: "$.event.id",
        // signingSecretCredentialId omitted
      }),
    ).toThrow();
  });

  it("requires eventIdField (non-empty)", () => {
    expect(() =>
      sourceWebhookBindingConfigSchema.parse({
        ...MINIMAL_VALID,
        eventIdField: "",
      }),
    ).toThrow();
    expect(() =>
      sourceWebhookBindingConfigSchema.parse({
        pathSegment: "hook",
        signingSecretCredentialId: VALID_UUID,
      }),
    ).toThrow();
  });

  it("reviewMode defaults to 'review' (THREAT-MODEL §3.7)", () => {
    const result = sourceWebhookBindingConfigSchema.parse(MINIMAL_VALID);
    expect(result.reviewMode).toBe("review");
  });

  it("reviewMode accepts 'auto' explicitly", () => {
    const result = sourceWebhookBindingConfigSchema.parse({
      ...MINIMAL_VALID,
      reviewMode: "auto",
    });
    expect(result.reviewMode).toBe("auto");
  });

  it("reviewMode rejects invalid values", () => {
    expect(() =>
      sourceWebhookBindingConfigSchema.parse({
        ...MINIMAL_VALID,
        reviewMode: "auto-approve",
      }),
    ).toThrow();
  });

  it("defaultContentKind defaults to 'document' (has a Compiler template in v0.1)", () => {
    const result = sourceWebhookBindingConfigSchema.parse(MINIMAL_VALID);
    expect(result.defaultContentKind).toBe("document");
  });

  it("defaultContentKind accepts other valid CONTENT_KINDS", () => {
    expect(() =>
      sourceWebhookBindingConfigSchema.parse({
        ...MINIMAL_VALID,
        defaultContentKind: "document",
      }),
    ).not.toThrow();
    expect(() =>
      sourceWebhookBindingConfigSchema.parse({
        ...MINIMAL_VALID,
        defaultContentKind: "n8n-workflow",
      }),
    ).not.toThrow();
  });

  it("defaultContentKind rejects unknown values", () => {
    expect(() =>
      sourceWebhookBindingConfigSchema.parse({
        ...MINIMAL_VALID,
        defaultContentKind: "not-a-content-kind",
      }),
    ).toThrow();
  });

  it("contentKindMap is optional (undefined by default)", () => {
    const result = sourceWebhookBindingConfigSchema.parse(MINIMAL_VALID);
    expect(result.contentKindMap).toBeUndefined();
  });

  it("contentKindMap accepts a Record<string, string>", () => {
    const result = sourceWebhookBindingConfigSchema.parse({
      ...MINIMAL_VALID,
      contentKindMap: {
        "$.event.type == 'n8n_workflow'": "n8n-workflow",
        "$.event.type == 'document'": "document",
      },
    });
    expect(result.contentKindMap).toBeDefined();
  });

  it("rejects unknown top-level fields (.strict)", () => {
    expect(() =>
      sourceWebhookBindingConfigSchema.parse({
        ...MINIMAL_VALID,
        unknownField: "oops",
      }),
    ).toThrow();
  });
});

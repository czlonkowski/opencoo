/**
 * Mock webhook payloads for use-case tests.
 * Builds realistic webhook bodies + valid HMAC-SHA256 signatures
 * against test secrets. Used by all four test files.
 */
import { createHmac } from "node:crypto";

export const WEBHOOK_SIGNATURE_HEADER = "x-webhook-signature";

export interface MockWebhookPayload {
  readonly body: Buffer;
  readonly secret: Buffer;
  readonly validSignature: string;
  readonly headers: Readonly<Record<string, string>>;
}

const DEFAULT_PAYLOAD = {
  event: {
    id: "evt-abc-123",
    type: "campaign.updated",
    data: { campaignId: "camp-42", status: "active" },
  },
  timestamp: "2026-05-01T10:00:00.000Z",
};

export function buildMockWebhookPayload(args?: {
  readonly payload?: Record<string, unknown>;
  readonly secret?: Buffer;
}): MockWebhookPayload {
  const payload = args?.payload ?? DEFAULT_PAYLOAD;
  const secret = args?.secret ?? Buffer.from("test-signing-secret");
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const validSignature = createHmac("sha256", secret).update(body).digest("hex");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [WEBHOOK_SIGNATURE_HEADER]: validSignature,
  };
  return { body, secret, validSignature, headers };
}

/**
 * Builds a payload whose event_id is nested at a non-trivial jsonpath.
 * Used by replay tests.
 */
export function buildMockWebhookPayloadNested(args?: {
  readonly payload?: Record<string, unknown>;
  readonly secret?: Buffer;
}): MockWebhookPayload {
  const payload = args?.payload ?? {
    payload: {
      event_id: "nested-event-id-999",
      kind: "task.created",
    },
  };
  const secret = args?.secret ?? Buffer.from("nested-signing-secret");
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const validSignature = createHmac("sha256", secret).update(body).digest("hex");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [WEBHOOK_SIGNATURE_HEADER]: validSignature,
  };
  return { body, secret, validSignature, headers };
}

/**
 * Builds an oversized payload (> 1 MiB) for ceiling tests.
 */
export function buildOversizedPayload(secret?: Buffer): MockWebhookPayload {
  const s = secret ?? Buffer.from("oversize-secret");
  // Put a valid event.id at the top so eventIdField extraction succeeds
  // before the size check; actual size check must happen on contentBytes.
  const basePayload = { event: { id: "oversize-evt" } };
  // Pad the body so the JSON exceeds 1 MiB.
  const padding = "x".repeat(1024 * 1024 + 100);
  const body = Buffer.from(
    JSON.stringify({ ...basePayload, padding }),
    "utf8",
  );
  const validSignature = createHmac("sha256", s).update(body).digest("hex");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [WEBHOOK_SIGNATURE_HEADER]: validSignature,
  };
  return { body, secret: s, validSignature, headers };
}

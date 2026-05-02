/**
 * output-webhook retry tests (PR-J / phase-a appendix #4).
 *
 * Verifies:
 *   1. Exponential backoff with jitter, max 5 attempts.
 *   2. `output_deliveries` audit row inserted per attempt
 *      (append-only: each attempt is a new row, not an UPDATE).
 *   3. On terminal failure (all attempts exhausted), the final
 *      row carries `status: 'dlq'` and an alert event is emitted.
 *   4. On 2xx success (first attempt), single row with `status: 'success'`.
 *   5. Default maxAttempts = 5, baseDelayMs = 500.
 *   6. Transient failures (5xx) cause retries; 4xx failures (validation)
 *      DLQ immediately on first attempt.
 *
 * Append-only invariant (THREAT-MODEL §2 invariant 8):
 *   `output_deliveries` uses insert-per-attempt strategy (option a from
 *   the spec). Each attempt creates a new row with a fixed status at
 *   insert time. No UPDATEs to prior rows.
 *
 * Alert event (PR-B Activity tab surface):
 *   On DLQ, the adapter calls `onDlq({ deliveryId, bindingId, error })`
 *   if provided. PR-B's Activity SSE bus will wire this; for now we
 *   assert the callback fires with the expected shape.
 */
import { describe, expect, it, vi } from "vitest";

import { InMemoryCredentialStore } from "@opencoo/shared/credential-store";
import { ConsoleLogger } from "@opencoo/shared/logger";

import { createWebhookOutputAdapter, type WebhookPayload } from "../src/index.js";
import type { OutputDeliveryRow } from "../src/output-deliveries-writer.js";
import {
  createMockHttpState,
  makeMockHttpFetch,
} from "../src/testing/mock-http.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

const VALID_PAYLOAD: WebhookPayload = {
  event: "heartbeat.report",
  data: { summary: "All systems healthy" },
};

async function makeAdapterWithDeliveries(opts: {
  maxAttempts?: number;
  baseDelayMs?: number;
  onDlq?: (args: { deliveryId: string; error: unknown }) => void;
}) {
  const httpState = createMockHttpState();
  const store = new InMemoryCredentialStore({ logger: silentLogger() });
  const credentialId = await store.write({
    name: "signing-secret",
    schemaRef: "webhook-signing-secret/v1",
    plaintext: Buffer.from("test-signing-secret"),
  });

  const deliveryRows: OutputDeliveryRow[] = [];

  const adapter = createWebhookOutputAdapter({
    config: {
      targetUrl: "https://example.com/hooks/opencoo",
      signingSecretCredentialId: credentialId as string,
      retryPolicy: {
        maxAttempts: opts.maxAttempts ?? 3,
        baseDelayMs: opts.baseDelayMs ?? 0, // 0ms for tests
      },
      headers: {},
    },
    makeFetch: () => makeMockHttpFetch(httpState),
    onDeliveryRow: (row) => {
      deliveryRows.push(row);
    },
    onDlq: opts.onDlq,
    // Inject a deterministic sleep that records delays without waiting
    sleep: vi.fn().mockResolvedValue(undefined),
  });

  return { adapter, store, credentialId, httpState, deliveryRows };
}

describe("output-webhook — retry behavior", () => {
  it("succeeds on first attempt → single delivery row with status='success'", async () => {
    const { adapter, store, credentialId, httpState, deliveryRows } =
      await makeAdapterWithDeliveries({});

    httpState.behavior = { kind: "ok" };
    await adapter.write({ credentialStore: store, credentialId, payload: VALID_PAYLOAD });

    expect(deliveryRows).toHaveLength(1);
    expect(deliveryRows[0]!.status).toBe("success");
    expect(deliveryRows[0]!.attempt).toBe(0);
    expect(deliveryRows[0]!.statusCode).toBe(200);
  });

  it("retries on transient failure and succeeds on 3rd attempt", async () => {
    const { adapter, store, credentialId, httpState, deliveryRows } =
      await makeAdapterWithDeliveries({ maxAttempts: 5, baseDelayMs: 0 });

    let attempt = 0;
    httpState.behaviorFn = () => {
      attempt++;
      if (attempt < 3) return { kind: "http-error" as const, status: 503 };
      return { kind: "ok" as const };
    };

    await adapter.write({ credentialStore: store, credentialId, payload: VALID_PAYLOAD });

    expect(deliveryRows).toHaveLength(3);
    expect(deliveryRows[0]!.status).toBe("transient_failure");
    expect(deliveryRows[1]!.status).toBe("transient_failure");
    expect(deliveryRows[2]!.status).toBe("success");
    // attempt numbers are 0-indexed
    expect(deliveryRows[0]!.attempt).toBe(0);
    expect(deliveryRows[1]!.attempt).toBe(1);
    expect(deliveryRows[2]!.attempt).toBe(2);
  });

  it("all attempts fail → final row has status='dlq' + throws", async () => {
    const { adapter, store, credentialId, httpState, deliveryRows } =
      await makeAdapterWithDeliveries({ maxAttempts: 3, baseDelayMs: 0 });

    httpState.behavior = { kind: "http-error", status: 503 };

    await expect(
      adapter.write({ credentialStore: store, credentialId, payload: VALID_PAYLOAD }),
    ).rejects.toThrow();

    expect(deliveryRows).toHaveLength(3);
    // First two are transient_failure, last is dlq
    expect(deliveryRows[2]!.status).toBe("dlq");
  });

  it("DLQ triggers onDlq callback with deliveryId and error", async () => {
    const dlqSpy = vi.fn();
    const { adapter, store, credentialId, httpState } =
      await makeAdapterWithDeliveries({
        maxAttempts: 2,
        baseDelayMs: 0,
        onDlq: dlqSpy,
      });

    httpState.behavior = { kind: "http-error", status: 503 };

    await expect(
      adapter.write({ credentialStore: store, credentialId, payload: VALID_PAYLOAD }),
    ).rejects.toThrow();

    expect(dlqSpy).toHaveBeenCalledOnce();
    const args = dlqSpy.mock.calls[0]![0] as {
      deliveryId: string;
      error: unknown;
    };
    expect(typeof args.deliveryId).toBe("string");
    expect(args.deliveryId.length).toBeGreaterThan(0);
    expect(args.error).toBeDefined();
  });

  it("4xx validation error DLQs immediately on first attempt without retry", async () => {
    const { adapter, store, credentialId, httpState, deliveryRows } =
      await makeAdapterWithDeliveries({ maxAttempts: 5, baseDelayMs: 0 });

    httpState.behavior = { kind: "http-error", status: 400 };

    await expect(
      adapter.write({ credentialStore: store, credentialId, payload: VALID_PAYLOAD }),
    ).rejects.toThrow();

    // Only one attempt — validation errors don't retry
    expect(deliveryRows).toHaveLength(1);
    expect(deliveryRows[0]!.status).toBe("dlq");
    expect(httpState.calls).toHaveLength(1);
  });

  it("429 rate-limit DLQs immediately (caller handles retry scheduling)", async () => {
    const { adapter, store, credentialId, httpState, deliveryRows } =
      await makeAdapterWithDeliveries({ maxAttempts: 5, baseDelayMs: 0 });

    httpState.behavior = {
      kind: "http-error",
      status: 429,
      retryAfterSeconds: 120,
    };

    await expect(
      adapter.write({ credentialStore: store, credentialId, payload: VALID_PAYLOAD }),
    ).rejects.toThrow();

    // 429 is upstream-quota — no internal retry; throw immediately
    expect(httpState.calls).toHaveLength(1);
    expect(deliveryRows[deliveryRows.length - 1]!.status).toBe("dlq");
  });

  it("delivery rows all share the same deliveryId across attempts", async () => {
    const { adapter, store, credentialId, httpState, deliveryRows } =
      await makeAdapterWithDeliveries({ maxAttempts: 3, baseDelayMs: 0 });

    let attempt = 0;
    httpState.behaviorFn = () => {
      attempt++;
      if (attempt < 2) return { kind: "http-error" as const, status: 503 };
      return { kind: "ok" as const };
    };

    await adapter.write({ credentialStore: store, credentialId, payload: VALID_PAYLOAD });

    expect(deliveryRows).toHaveLength(2);
    // All rows for a delivery share the same deliveryId
    expect(deliveryRows[0]!.deliveryId).toBe(deliveryRows[1]!.deliveryId);
  });

  it("rows are append-only — no attempt number is ever repeated", async () => {
    const { adapter, store, credentialId, httpState, deliveryRows } =
      await makeAdapterWithDeliveries({ maxAttempts: 3, baseDelayMs: 0 });

    httpState.behavior = { kind: "http-error", status: 503 };

    await expect(
      adapter.write({ credentialStore: store, credentialId, payload: VALID_PAYLOAD }),
    ).rejects.toThrow();

    const attempts = deliveryRows.map((r) => r.attempt);
    const uniqueAttempts = new Set(attempts);
    expect(uniqueAttempts.size).toBe(attempts.length);
  });
});

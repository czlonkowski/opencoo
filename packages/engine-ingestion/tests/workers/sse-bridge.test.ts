/**
 * sse-bridge contract tests (PR-M1, phase-a appendix #5).
 *
 * `attachRunEvents` is the boundary the THREAT-MODEL §5 PR
 * checklist rests on — it sits between BullMQ Worker events and
 * the SSE bus that fans run-events out to the management UI.
 *
 * Three contract assertions:
 *   1. `failed` events redact credential patterns via `scrubPat`
 *      AND cap the error string at 200 chars before emission.
 *   2. `completed` events carry the BullMQ-supplied
 *      `processedOn` / `finishedOn` timestamps verbatim.
 *   3. `active` events carry status `"running"` keyed on `job.id`.
 *
 * Tests construct a real `Worker` via `buildEngineWorker`
 * (`autorun: false`) against `ioredis-mock`, then synthesise the
 * lifecycle by emitting the events directly — the listeners we
 * want to verify don't depend on the BullMQ pull loop.
 */
import IORedisMock from "ioredis-mock";
import { describe, expect, it } from "vitest";

import { buildEngineWorker } from "@opencoo/shared/engine-scaffold";

import { attachRunEvents } from "../../src/workers/sse-bridge.js";
import type {
  IngestionRunEvent,
  IngestionRunEventEmitter,
} from "../../src/workers/context.js";

interface CapturingEmitter extends IngestionRunEventEmitter {
  readonly events: IngestionRunEvent[];
}

function capturingEmitter(): CapturingEmitter {
  const events: IngestionRunEvent[] = [];
  return {
    events,
    emitRunEvent(event) {
      events.push(event);
    },
  };
}

/** Fake job with the minimal shape `attachRunEvents` reads.
 *  Cast to BullMQ's Job type because the listeners only touch
 *  `id`, `processedOn`, and `finishedOn`. */
function fakeJob(args: {
  id?: string;
  processedOn?: number;
  finishedOn?: number;
}): unknown {
  return {
    id: args.id ?? "job-1",
    ...(args.processedOn !== undefined ? { processedOn: args.processedOn } : {}),
    ...(args.finishedOn !== undefined ? { finishedOn: args.finishedOn } : {}),
  };
}

describe("attachRunEvents — failed event PAT scrub", () => {
  it("scrubs Bearer tokens from error messages and caps at 200 chars", async () => {
    const redis = new IORedisMock();
    const worker = buildEngineWorker(
      "ingestion",
      "test-failed",
      async () => undefined,
      {
        connection: redis as unknown as Parameters<
          typeof buildEngineWorker
        >[3]["connection"],
        autorun: false,
      },
    );
    const emitter = capturingEmitter();
    attachRunEvents(worker, "ingestion.test-failed", emitter);

    // Bearer token in an error message is the canonical leak
    // shape — scrubPat must redact it before SSE emission.
    const err = new Error(
      "Bearer sk-or-v1-deadbeefcafef00d0123456789abcdef in error: Authorization failed",
    );
    worker.emit("failed", fakeJob({ id: "job-fail" }) as never, err, "active");

    expect(emitter.events).toHaveLength(1);
    const event = emitter.events[0]!;
    expect(event.runId).toBe("job-fail");
    expect(event.status).toBe("failed");
    expect(event.errorClass).toBeDefined();
    expect(event.errorClass).not.toContain("sk-or-v1-deadbeef");
    expect(event.errorClass).toContain("[REDACTED]");
    expect(event.errorClass!.length).toBeLessThanOrEqual(200);

    await worker.close();
    redis.disconnect();
  });

  it("caps long error strings at 200 chars (slice applied after scrub)", async () => {
    const redis = new IORedisMock();
    const worker = buildEngineWorker(
      "ingestion",
      "test-long-err",
      async () => undefined,
      {
        connection: redis as unknown as Parameters<
          typeof buildEngineWorker
        >[3]["connection"],
        autorun: false,
      },
    );
    const emitter = capturingEmitter();
    attachRunEvents(worker, "ingestion.test-long-err", emitter);

    // 500-char prose interleaved with non-redactable tokens (each
    // run is < 32 alphanum so the generic-token regex doesn't fire).
    // The scrub leaves the message untouched; the 200-char slice
    // is what enforces the SSE-frame bound.
    const longMessage = ("word ".repeat(120)).trim();
    expect(longMessage.length).toBeGreaterThan(200);
    worker.emit(
      "failed",
      fakeJob({ id: "job-long" }) as never,
      new Error(longMessage),
      "active",
    );

    const event = emitter.events[0]!;
    expect(event.errorClass!.length).toBe(200);

    await worker.close();
    redis.disconnect();
  });
});

describe("attachRunEvents — active event", () => {
  it("emits status='running' with job.id as runId", async () => {
    const redis = new IORedisMock();
    const worker = buildEngineWorker(
      "ingestion",
      "test-active",
      async () => undefined,
      {
        connection: redis as unknown as Parameters<
          typeof buildEngineWorker
        >[3]["connection"],
        autorun: false,
      },
    );
    const emitter = capturingEmitter();
    attachRunEvents(worker, "ingestion.test-active", emitter);

    worker.emit("active", fakeJob({ id: "job-active" }) as never, "waiting");

    expect(emitter.events).toHaveLength(1);
    const event = emitter.events[0]!;
    expect(event).toMatchObject({
      runId: "job-active",
      definitionSlug: "ingestion.test-active",
      status: "running",
    });
    expect(typeof event.startedAt).toBe("string");

    await worker.close();
    redis.disconnect();
  });
});

describe("attachRunEvents — completed event", () => {
  it("emits status='success' with processedOn/finishedOn timestamps", async () => {
    const redis = new IORedisMock();
    const worker = buildEngineWorker(
      "ingestion",
      "test-completed",
      async () => undefined,
      {
        connection: redis as unknown as Parameters<
          typeof buildEngineWorker
        >[3]["connection"],
        autorun: false,
      },
    );
    const emitter = capturingEmitter();
    attachRunEvents(worker, "ingestion.test-completed", emitter);

    const processedOn = Date.parse("2026-04-25T12:00:00Z");
    const finishedOn = Date.parse("2026-04-25T12:00:05Z");
    worker.emit(
      "completed",
      fakeJob({ id: "job-ok", processedOn, finishedOn }) as never,
      undefined,
      "active",
    );

    expect(emitter.events).toHaveLength(1);
    const event = emitter.events[0]!;
    expect(event).toMatchObject({
      runId: "job-ok",
      definitionSlug: "ingestion.test-completed",
      status: "success",
      startedAt: new Date(processedOn).toISOString(),
      endedAt: new Date(finishedOn).toISOString(),
    });

    await worker.close();
    redis.disconnect();
  });
});

describe("attachRunEvents — undefined bus is a no-op", () => {
  it("does not register any listeners when bus is undefined", async () => {
    const redis = new IORedisMock();
    const worker = buildEngineWorker(
      "ingestion",
      "test-noop",
      async () => undefined,
      {
        connection: redis as unknown as Parameters<
          typeof buildEngineWorker
        >[3]["connection"],
        autorun: false,
      },
    );
    const before = worker.listenerCount("failed");
    attachRunEvents(worker, "ingestion.test-noop", undefined);
    const after = worker.listenerCount("failed");
    expect(after).toBe(before);
    await worker.close();
    redis.disconnect();
  });
});

/**
 * SseBus — RunEvent shape pins (round-3 PR #53 follow-up).
 *
 * `RunEvent.errorMessage` was added so the ingestion-engine
 * sse-bridge (PR-M1) can surface scrubbed BullMQ error messages
 * over SSE without overloading the typed retry-class taxonomy
 * (`OpencooError.errorClass`). This test pins the round-trip:
 * a RunEvent emitted with `errorMessage` reaches subscribers
 * with the field intact.
 *
 * The companion field `errorClass` (used by the agent-harness)
 * round-trips alongside; both can be present, neither, or one
 * — the bus is a structural pass-through.
 */
import { describe, expect, it } from "vitest";

import {
  createSseBus,
  type RunEvent,
} from "../../src/admin-api/sse-bus.js";

describe("SseBus — RunEvent.errorMessage round-trip", () => {
  it("delivers errorMessage to subscribers verbatim", () => {
    const bus = createSseBus();
    const received: RunEvent[] = [];
    bus.onRunEvent((e) => received.push(e));

    bus.emitRunEvent({
      runId: "job-fail-1",
      definitionSlug: "ingestion.scanner.classify",
      status: "failed",
      startedAt: "2026-05-02T10:00:00.000Z",
      endedAt: "2026-05-02T10:00:05.000Z",
      errorMessage:
        "compilation-worker: binding 00000000-... not found or disabled",
    });

    expect(received).toHaveLength(1);
    const evt = received[0]!;
    expect(evt.status).toBe("failed");
    expect(evt.errorMessage).toBe(
      "compilation-worker: binding 00000000-... not found or disabled",
    );
  });

  it("delivers errorClass and errorMessage independently", () => {
    // The agent-harness writes errorClass (typed retry taxonomy).
    // The ingestion sse-bridge writes errorMessage (free-text scrub).
    // Both can ride one event when a producer sets both, or one,
    // or neither — they are STRUCTURALLY independent fields.
    const bus = createSseBus();
    const received: RunEvent[] = [];
    bus.onRunEvent((e) => received.push(e));

    bus.emitRunEvent({
      runId: "job-fail-2",
      definitionSlug: "selfop.heartbeat",
      status: "failed",
      startedAt: "2026-05-02T10:00:00.000Z",
      endedAt: "2026-05-02T10:00:01.000Z",
      errorClass: "transient",
      errorMessage: "Provider 503 Service Unavailable",
    });

    expect(received).toHaveLength(1);
    const evt = received[0]!;
    expect(evt.errorClass).toBe("transient");
    expect(evt.errorMessage).toBe("Provider 503 Service Unavailable");
  });

  it("treats an event without either error field as normal", () => {
    const bus = createSseBus();
    const received: RunEvent[] = [];
    bus.onRunEvent((e) => received.push(e));

    bus.emitRunEvent({
      runId: "job-ok-1",
      definitionSlug: "ingestion.scanner",
      status: "success",
      startedAt: "2026-05-02T10:00:00.000Z",
      endedAt: "2026-05-02T10:00:02.000Z",
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.errorClass).toBeUndefined();
    expect(received[0]?.errorMessage).toBeUndefined();
  });
});

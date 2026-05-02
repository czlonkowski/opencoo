/**
 * Streamed tokens — LLM router emits per-token events; SSE bus
 * relays them to connected clients.
 *
 * Test-first artifact for PR-B (phase-a appendix #4).
 *
 * The SSE bus is an in-process EventEmitter. This test-suite
 * verifies the bus contract:
 *   1. `emitToken` publishes a `token` event on the bus.
 *   2. `emitRunEvent` publishes a structured `agent_run` event.
 *   3. Events carry required fields.
 *   4. Prompt text is gated: `emitToken` with `includePrompt=false`
 *      must NOT include `promptText` in the event (invariant 11).
 *   5. When `includePrompt=true`, `promptText` is included.
 *   6. Bus is an EventEmitter — subscribers can listen + unsubscribe.
 */
import { describe, expect, it } from "vitest";

import {
  createSseBus,
  type TokenEvent,
  type RunEvent,
} from "../../src/admin-api/sse-bus.js";

describe("SseBus — token event emission", () => {
  it("emitToken publishes a token event on the bus", () => {
    const bus = createSseBus();
    const received: TokenEvent[] = [];
    bus.onToken((e) => received.push(e));

    bus.emitToken({
      runId: "run-1",
      token: "Hello",
      includePrompt: false,
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.runId).toBe("run-1");
    expect(received[0]!.token).toBe("Hello");
  });

  it("does NOT include promptText when includePrompt=false (THREAT-MODEL §2 invariant 11)", () => {
    const bus = createSseBus();
    const received: TokenEvent[] = [];
    bus.onToken((e) => received.push(e));

    bus.emitToken({
      runId: "run-1",
      token: "token",
      promptText: "system: you are a COO...",
      includePrompt: false,
    });

    expect(received[0]).toBeDefined();
    expect("promptText" in received[0]!).toBe(false);
  });

  it("includes promptText when includePrompt=true (LLM_DEBUG_LOG=1 gate open)", () => {
    const bus = createSseBus();
    const received: TokenEvent[] = [];
    bus.onToken((e) => received.push(e));

    bus.emitToken({
      runId: "run-1",
      token: "token",
      promptText: "system: you are a COO...",
      includePrompt: true,
    });

    expect(received[0]).toBeDefined();
    expect(received[0]!["promptText"]).toBe("system: you are a COO...");
  });

  it("can unsubscribe from token events", () => {
    const bus = createSseBus();
    const received: TokenEvent[] = [];
    const off = bus.onToken((e) => received.push(e));

    bus.emitToken({ runId: "run-1", token: "a", includePrompt: false });
    off();
    bus.emitToken({ runId: "run-1", token: "b", includePrompt: false });

    expect(received).toHaveLength(1); // only "a", not "b"
  });
});

describe("SseBus — run event emission", () => {
  it("emitRunEvent publishes a run event on the bus", () => {
    const bus = createSseBus();
    const received: RunEvent[] = [];
    bus.onRunEvent((e) => received.push(e));

    bus.emitRunEvent({
      runId: "run-2",
      definitionSlug: "heartbeat",
      status: "running",
      startedAt: new Date().toISOString(),
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.runId).toBe("run-2");
    expect(received[0]!.status).toBe("running");
    expect(received[0]!.definitionSlug).toBe("heartbeat");
  });

  it("run event carries all required fields", () => {
    const bus = createSseBus();
    const received: RunEvent[] = [];
    bus.onRunEvent((e) => received.push(e));

    const now = new Date().toISOString();
    bus.emitRunEvent({
      runId: "run-3",
      definitionSlug: "lint",
      status: "success",
      startedAt: now,
      endedAt: now,
      tokensIn: 100,
      tokensOut: 200,
      costUsd: "0.001",
      latencyMs: 1500,
    });

    const evt = received[0]!;
    expect(evt.runId).toBe("run-3");
    expect(evt.tokensIn).toBe(100);
    expect(evt.costUsd).toBe("0.001");
  });

  it("multiple subscribers all receive events", () => {
    const bus = createSseBus();
    const a: RunEvent[] = [];
    const b: RunEvent[] = [];
    bus.onRunEvent((e) => a.push(e));
    bus.onRunEvent((e) => b.push(e));

    bus.emitRunEvent({
      runId: "run-4",
      definitionSlug: "heartbeat",
      status: "running",
      startedAt: new Date().toISOString(),
    });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});

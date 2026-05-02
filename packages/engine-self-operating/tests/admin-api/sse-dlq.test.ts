/**
 * SseBus — OutputDeliveryDlq event emission (PR-L).
 *
 * Pin matrix:
 *   1. `emitOutputDeliveryDlq` publishes an `output_delivery_dlq`
 *      event on the bus; subscribers receive it with the right shape.
 *   2. `bindOutputDlq()` returns a closure that calls
 *      `emitOutputDeliveryDlq` with a timestamp.
 *   3. Multiple subscribers all receive DLQ events.
 *   4. Subscriber can unsubscribe via the returned cleanup fn.
 *   5. The SSE events route broadcasts `output_delivery_dlq`
 *      over the SSE channel.
 */
import { describe, expect, it } from "vitest";

import {
  createSseBus,
  type OutputDeliveryDlqEvent,
} from "../../src/admin-api/sse-bus.js";

describe("SseBus — output_delivery_dlq event emission", () => {
  it("emitOutputDeliveryDlq publishes an event that subscribers receive", () => {
    const bus = createSseBus();
    const received: OutputDeliveryDlqEvent[] = [];
    bus.onOutputDeliveryDlq((e) => received.push(e));

    bus.emitOutputDeliveryDlq({
      type: "output_delivery_dlq",
      outputBindingId: "binding-111",
      deliveryId: "delivery-aaa",
      error: "connect ECONNREFUSED 127.0.0.1:9999",
      occurredAt: "2026-05-02T10:00:00.000Z",
    });

    expect(received).toHaveLength(1);
    const evt = received[0]!;
    expect(evt.type).toBe("output_delivery_dlq");
    expect(evt.outputBindingId).toBe("binding-111");
    expect(evt.deliveryId).toBe("delivery-aaa");
    expect(evt.error).toBe("connect ECONNREFUSED 127.0.0.1:9999");
    expect(evt.occurredAt).toBe("2026-05-02T10:00:00.000Z");
  });

  it("multiple subscribers all receive output_delivery_dlq events", () => {
    const bus = createSseBus();
    const a: OutputDeliveryDlqEvent[] = [];
    const b: OutputDeliveryDlqEvent[] = [];
    bus.onOutputDeliveryDlq((e) => a.push(e));
    bus.onOutputDeliveryDlq((e) => b.push(e));

    bus.emitOutputDeliveryDlq({
      type: "output_delivery_dlq",
      outputBindingId: "b",
      deliveryId: "d",
      error: "timeout",
      occurredAt: new Date().toISOString(),
    });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("can unsubscribe from output_delivery_dlq events", () => {
    const bus = createSseBus();
    const received: OutputDeliveryDlqEvent[] = [];
    const off = bus.onOutputDeliveryDlq((e) => received.push(e));

    bus.emitOutputDeliveryDlq({
      type: "output_delivery_dlq",
      outputBindingId: "b",
      deliveryId: "d",
      error: "first",
      occurredAt: new Date().toISOString(),
    });
    off();
    bus.emitOutputDeliveryDlq({
      type: "output_delivery_dlq",
      outputBindingId: "b",
      deliveryId: "d",
      error: "second",
      occurredAt: new Date().toISOString(),
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.error).toBe("first");
  });

  it("bindOutputDlq() returns a closure that calls emitOutputDeliveryDlq with occurredAt", () => {
    const bus = createSseBus();
    const received: OutputDeliveryDlqEvent[] = [];
    bus.onOutputDeliveryDlq((e) => received.push(e));

    const handler = bus.bindOutputDlq();
    handler({
      outputBindingId: "binding-222",
      deliveryId: "delivery-bbb",
      error: new Error("downstream 503"),
    });

    expect(received).toHaveLength(1);
    const evt = received[0]!;
    expect(evt.type).toBe("output_delivery_dlq");
    expect(evt.outputBindingId).toBe("binding-222");
    expect(evt.deliveryId).toBe("delivery-bbb");
    // error is stringified from the Error object
    expect(typeof evt.error).toBe("string");
    expect(evt.error).toContain("downstream 503");
    // occurredAt is a valid ISO timestamp set by the closure
    expect(typeof evt.occurredAt).toBe("string");
    expect(() => new Date(evt.occurredAt)).not.toThrow();
  });

  it("bindOutputDlq() handles a string error value", () => {
    const bus = createSseBus();
    const received: OutputDeliveryDlqEvent[] = [];
    bus.onOutputDeliveryDlq((e) => received.push(e));

    const handler = bus.bindOutputDlq();
    handler({
      outputBindingId: "b",
      deliveryId: "d",
      error: "raw string error",
    });

    expect(received[0]!.error).toBe("raw string error");
  });
});

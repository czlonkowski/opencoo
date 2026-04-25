/**
 * `OutputChannelRegistry` — engine-internal router for agent
 * deliverables. The Heartbeat + Lint agents return a JSON
 * payload; the engine's post-run hook routes that payload to
 * the channels listed in the instance's
 * `agent_instances.output_channel_ids` JSONB column. Per Q10:
 * `output_channel_deliver` is NOT a tool the LLM invokes — it's
 * an out-of-band side effect post-LLM, so the LLM cannot be
 * tricked via prompt injection into delivering to an unrelated
 * channel.
 *
 * The registry enforces the binding at the gate:
 *   - The `outputChannelIds[]` is the closed set for the
 *     instance.
 *   - A `deliver()` call with an `adapter_slug` not in that set
 *     is rejected with `OutputChannelMismatchError` (validation
 *     class).
 *   - Within the closed set, the registry dispatches to the
 *     concrete `OutputChannelAdapter` registered for that slug.
 *
 * Plan #92 part A — `MockOutputChannelAdapter` is the in-memory
 * fixture that captures every delivery for assertion.
 */
import { describe, expect, it, beforeEach } from "vitest";

import {
  MockOutputChannelAdapter,
  OutputChannelMismatchError,
  OutputChannelRegistry,
  OutputChannelUnknownAdapterError,
  type OutputChannelBinding,
  type OutputChannelDelivery,
} from "../../src/output-channels/index.js";

describe("OutputChannelRegistry — adapter lookup", () => {
  it("registers adapters by slug and looks them up", () => {
    const registry = new OutputChannelRegistry();
    const slack = new MockOutputChannelAdapter("slack");
    registry.register(slack);
    expect(registry.get("slack")).toBe(slack);
  });

  it("rejects duplicate adapter registration with explicit error", () => {
    const registry = new OutputChannelRegistry();
    registry.register(new MockOutputChannelAdapter("slack"));
    expect(() =>
      registry.register(new MockOutputChannelAdapter("slack")),
    ).toThrow(/duplicate/i);
  });

  it("get() returns undefined for unknown slug", () => {
    const registry = new OutputChannelRegistry();
    expect(registry.get("does-not-exist")).toBeUndefined();
  });
});

describe("OutputChannelRegistry — deliver enforces instance binding", () => {
  let registry: OutputChannelRegistry;
  let slack: MockOutputChannelAdapter;
  let email: MockOutputChannelAdapter;

  beforeEach(() => {
    registry = new OutputChannelRegistry();
    slack = new MockOutputChannelAdapter("slack");
    email = new MockOutputChannelAdapter("email");
    registry.register(slack);
    registry.register(email);
  });

  it("delivers to a slug that IS in the instance's outputChannelIds[]", async () => {
    const bindings: readonly OutputChannelBinding[] = [
      { adapter_slug: "slack", config: { channel: "#opencoo-heartbeat" } },
    ];
    const delivery: OutputChannelDelivery = {
      adapterSlug: "slack",
      payload: { summary: "hello", alerts: [] },
    };
    await registry.deliver({ bindings, delivery });
    expect(slack.deliveries).toHaveLength(1);
    expect(slack.deliveries[0]?.payload).toEqual({ summary: "hello", alerts: [] });
    expect(slack.deliveries[0]?.config).toEqual({ channel: "#opencoo-heartbeat" });
  });

  it("rejects a slug NOT in the instance's outputChannelIds[] with OutputChannelMismatchError", async () => {
    // Instance is bound to slack only — attempting to deliver to
    // email must fail at the registry gate even though the
    // registry itself knows the email adapter.
    const bindings: readonly OutputChannelBinding[] = [
      { adapter_slug: "slack", config: {} },
    ];
    const delivery: OutputChannelDelivery = {
      adapterSlug: "email",
      payload: { foo: 1 },
    };
    await expect(
      registry.deliver({ bindings, delivery }),
    ).rejects.toBeInstanceOf(OutputChannelMismatchError);
    // No adapter received the payload.
    expect(slack.deliveries).toHaveLength(0);
    expect(email.deliveries).toHaveLength(0);
  });

  it("rejects delivery to a slug for which no adapter is registered", async () => {
    const bindings: readonly OutputChannelBinding[] = [
      { adapter_slug: "asana", config: {} },
    ];
    const delivery: OutputChannelDelivery = {
      adapterSlug: "asana",
      payload: { foo: 1 },
    };
    await expect(
      registry.deliver({ bindings, delivery }),
    ).rejects.toBeInstanceOf(OutputChannelUnknownAdapterError);
  });

  it("OutputChannelMismatchError is errorClass='validation' (DLQ-routable)", async () => {
    const bindings: readonly OutputChannelBinding[] = [
      { adapter_slug: "slack", config: {} },
    ];
    try {
      await registry.deliver({
        bindings,
        delivery: { adapterSlug: "email", payload: {} },
      });
      throw new Error("expected throw");
    } catch (err) {
      // Type guard — OpencooError sets errorClass.
      expect((err as { errorClass?: string }).errorClass).toBe("validation");
    }
  });

  it("passes through the per-binding config to the adapter (cross-instance config does NOT leak)", async () => {
    // Two different instances would bind slack with different
    // configs (channel:#a vs channel:#b). The registry must use
    // the binding's config for THIS delivery, not a registry-
    // wide default.
    const bindings: readonly OutputChannelBinding[] = [
      { adapter_slug: "slack", config: { channel: "#hr-private" } },
    ];
    await registry.deliver({
      bindings,
      delivery: { adapterSlug: "slack", payload: { ok: true } },
    });
    expect(slack.deliveries[0]?.config).toEqual({ channel: "#hr-private" });
  });
});

describe("MockOutputChannelAdapter — in-memory fixture for tests", () => {
  it("captures the full delivery sequence in order", async () => {
    const slack = new MockOutputChannelAdapter("slack");
    await slack.deliver({ payload: { n: 1 }, config: {} });
    await slack.deliver({ payload: { n: 2 }, config: { channel: "#x" } });
    expect(slack.deliveries).toHaveLength(2);
    expect(slack.deliveries[0]?.payload).toEqual({ n: 1 });
    expect(slack.deliveries[1]?.config).toEqual({ channel: "#x" });
  });

  it("exposes adapterSlug for registration", () => {
    const a = new MockOutputChannelAdapter("hooks");
    expect(a.adapterSlug).toBe("hooks");
  });

  it("reset() clears the captured delivery log", async () => {
    const slack = new MockOutputChannelAdapter("slack");
    await slack.deliver({ payload: { n: 1 }, config: {} });
    slack.reset();
    expect(slack.deliveries).toHaveLength(0);
  });
});

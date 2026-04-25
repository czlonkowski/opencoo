/**
 * Public surface for the engine-self-operating output-channel
 * subsystem (PR 20, plan #92 part A).
 *
 * The Heartbeat + Lint agents return JSON; the engine's post-run
 * hook routes that JSON to the channels listed in the
 * instance's `agent_instances.output_channel_ids` JSONB. The
 * registry enforces the binding before dispatching so a
 * prompt-injection attack on the agent cannot redirect delivery
 * (see Q10 / THREAT-MODEL §3.5).
 */

export {
  type OutputChannelAdapter,
  type OutputChannelDeliverArgs,
} from "./interface.js";

export {
  OutputChannelMismatchError,
  OutputChannelUnknownAdapterError,
} from "./errors.js";

export {
  OutputChannelRegistry,
  type OutputChannelBinding,
  type OutputChannelDelivery,
  type OutputChannelDeliverInvocation,
} from "./registry.js";

export {
  MockOutputChannelAdapter,
  type CapturedDelivery,
} from "./testing/mock-adapter.js";

/**
 * `MockOutputChannelAdapter` — in-memory `OutputChannelAdapter`
 * fixture for tests. Captures every successful delivery in a
 * mutable array so a test can assert what got delivered,
 * with what config, in which order.
 *
 * Concrete adapters (Slack, email, Asana, webhook) land in
 * PR 23+; this mock is what the v0.1 engine-self-operating
 * tests use to drive the agent post-run hook end-to-end.
 */
import type {
  OutputChannelAdapter,
  OutputChannelDeliverArgs,
} from "../interface.js";

export interface CapturedDelivery {
  readonly payload: unknown;
  readonly config: Record<string, unknown>;
}

export class MockOutputChannelAdapter implements OutputChannelAdapter {
  readonly adapterSlug: string;
  private readonly captured: CapturedDelivery[] = [];

  constructor(adapterSlug: string) {
    this.adapterSlug = adapterSlug;
  }

  get deliveries(): readonly CapturedDelivery[] {
    return this.captured;
  }

  async deliver(args: OutputChannelDeliverArgs): Promise<void> {
    this.captured.push({ payload: args.payload, config: args.config });
  }

  reset(): void {
    this.captured.length = 0;
  }
}

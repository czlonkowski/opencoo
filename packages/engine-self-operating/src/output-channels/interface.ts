/**
 * `OutputChannelAdapter` — port for delivery of agent JSON
 * payloads to a downstream system (Slack, email, Asana,
 * webhooks). Concrete adapters land alongside the SourceAdapter
 * cohort in PR 23+. v0.1 ships only the port shape + the
 * `MockOutputChannelAdapter` test fixture.
 *
 * Per Q10 (architecture §9.4 + THREAT-MODEL §3.5):
 * `output_channel_deliver` is NOT a tool the LLM invokes. The
 * agent body returns a JSON payload via the harness
 * (`agent_runs.output`); the engine's post-run hook then routes
 * it to the configured channel. Keeping delivery out-of-band
 * means a prompt-injection attack on the agent cannot redirect
 * the payload to a different audience.
 *
 * Each delivery carries:
 *   - `payload` — the agent's JSON output (already validated
 *     against the agent's `outputSchemaName`).
 *   - `config` — the per-binding adapter config from
 *     `agent_instances.output_channel_ids[].config` (e.g.
 *     `{ channel: "#opencoo-heartbeat" }` for Slack). The
 *     binding's config is the closed set; the registry uses
 *     it verbatim.
 */
export interface OutputChannelAdapter {
  /** Stable slug identifying the adapter. Concrete adapters
   *  declare a single slug and are looked up by it via
   *  `OutputChannelRegistry.get(slug)`. */
  readonly adapterSlug: string;
  /** Deliver one payload. Concrete implementations implement
   *  the side-effecting step (HTTP POST, SDK call, etc.).
   *  Failures throw — the caller (registry / agent post-run
   *  hook) maps to error class. */
  deliver(args: OutputChannelDeliverArgs): Promise<void>;
}

export interface OutputChannelDeliverArgs {
  readonly payload: unknown;
  readonly config: Record<string, unknown>;
}

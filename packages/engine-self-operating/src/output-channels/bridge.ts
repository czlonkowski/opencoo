/**
 * `outputAdapterToChannelAdapter` — bridge that wraps a generic
 * `OutputAdapter<TPayload>` (shared port) into an
 * `OutputChannelAdapter` (engine-internal Q10 port).
 *
 * Why two ports exist: see `interface.ts` and the
 * `@opencoo/shared/output-adapter` interface.ts naming note.
 * Briefly:
 *
 *   - `OutputAdapter<T>` carries the payload + credentialId +
 *     credentialStore signature — the contract shared with the
 *     adapter-author surface (PR 24 / `@opencoo/output-asana`).
 *   - `OutputChannelAdapter` carries the engine's per-instance
 *     binding-enforcement signature (`deliver({payload, config})`)
 *     where `config` is the verbatim per-binding config from
 *     `agent_instances.output_channel_ids[].config`. The registry
 *     enforces Q10 binding BEFORE this is called.
 *
 * The bridge maps engine-shape → adapter-shape at delivery time:
 *
 *   1. Take `config` (per-binding closed set) — expected to carry
 *      `channel_id` (uuid pointing at the `output_channels` row).
 *   2. Call the injected `lookupChannel(channel_id)` to load the
 *      channel's `{credentialsId, config: channelConfig, enabled}`.
 *   3. If `enabled === false` → throw `OutputChannelDisabledError`
 *      (validation → DLQ; operator either re-enables or removes
 *      the binding).
 *   4. Merge `channelConfig` (operator-config) into the agent's
 *      payload skeleton and call `adapter.write({payload,
 *      credentialStore, credentialId})`.
 *
 * The merge step uses the adapter's `payloadFromConfigAndOutput`
 * closure — different adapters require different merges (Asana
 * needs `projectGid` from channel config + `title/notes` from
 * agent output; a future Slack adapter needs `channel` from
 * channel config + `text` from agent output). Centralising the
 * shape here keeps the registry layer adapter-agnostic.
 */
import type { CredentialStore } from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import type { OutputAdapter } from "@opencoo/shared/output-adapter";

import {
  OutputChannelDisabledError,
  OutputChannelLookupError,
  OutputChannelMissingChannelIdError,
} from "./errors.js";
import type {
  OutputChannelAdapter,
  OutputChannelDeliverArgs,
} from "./interface.js";

/** Closed shape returned by the channel-row lookup. */
export interface OutputChannelRecord {
  readonly id: string;
  readonly adapterSlug: string;
  readonly credentialsId: CredentialId;
  /** Per-channel operator config (e.g. Asana `{ project_gid }`).
   *  Stored verbatim in `output_channels.config`. The bridge passes
   *  this to the per-adapter merge closure. */
  readonly config: Record<string, unknown>;
  readonly enabled: boolean;
}

/** Channel-row lookup callable injected at composition. Production
 *  wires a Drizzle query against `output_channels`; tests pass an
 *  in-memory Map probe. Returns `null` when no row matches the id
 *  (dangling binding — the dispatcher logs + skips). */
export type LookupOutputChannel = (
  channelId: string,
) => Promise<OutputChannelRecord | null>;

/** Per-adapter merge closure — combines the channel's operator
 *  config with the agent's emitted JSON output into the adapter's
 *  payload shape. The closure runs INSIDE the bridge after the
 *  channel row is resolved, before the `write()` call.
 *
 *  For Asana: `(channelConfig, agentOutput) => {
 *    projectGid: channelConfig.project_gid,
 *    title: deriveTitle(agentOutput),
 *    notes: deriveNotes(agentOutput),
 *  }`.
 *
 *  The closure MUST be pure / side-effect-free — the bridge does
 *  no extra validation; the adapter's Zod schema parses + rejects
 *  malformed payloads downstream. */
export type MergePayload<TPayload> = (args: {
  readonly channelConfig: Record<string, unknown>;
  readonly agentOutput: unknown;
}) => TPayload;

export interface OutputAdapterToChannelAdapterArgs<TPayload> {
  /** The concrete `OutputAdapter` instance (e.g. result of
   *  `createAsanaOutputAdapter(...)`). The bridge reads the
   *  adapter's `slug` for registry registration. */
  readonly outputAdapter: OutputAdapter<TPayload>;
  /** Channel-row lookup — injected at composition. */
  readonly lookupChannel: LookupOutputChannel;
  /** Credential store — injected once at composition; the bridge
   *  passes it verbatim into `outputAdapter.write`. */
  readonly credentialStore: CredentialStore;
  /** Per-adapter payload-merge closure. See `MergePayload`. */
  readonly mergePayload: MergePayload<TPayload>;
}

/** Construct an `OutputChannelAdapter` that delegates to the
 *  given `OutputAdapter` via the per-channel row lookup. */
export function outputAdapterToChannelAdapter<TPayload>(
  args: OutputAdapterToChannelAdapterArgs<TPayload>,
): OutputChannelAdapter {
  const adapterSlug = args.outputAdapter.slug;
  return {
    adapterSlug,
    async deliver(deliverArgs: OutputChannelDeliverArgs): Promise<void> {
      const channelId = deliverArgs.config["channel_id"];
      if (typeof channelId !== "string" || channelId.length === 0) {
        throw new OutputChannelMissingChannelIdError(adapterSlug);
      }
      const record = await args.lookupChannel(channelId);
      if (record === null) {
        throw new OutputChannelLookupError(adapterSlug, channelId);
      }
      if (!record.enabled) {
        throw new OutputChannelDisabledError(adapterSlug, channelId);
      }
      const payload = args.mergePayload({
        channelConfig: record.config,
        agentOutput: deliverArgs.payload,
      });
      await args.outputAdapter.write({
        credentialStore: args.credentialStore,
        credentialId: record.credentialsId,
        payload,
      });
    },
  };
}

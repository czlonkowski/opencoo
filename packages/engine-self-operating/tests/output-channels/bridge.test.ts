/**
 * `outputAdapterToChannelAdapter` bridge tests (PR-Z4, phase-a
 * appendix #12 G5).
 *
 * Pins:
 *   - happy path: deliver merges channel-config with agent-output
 *     and calls the wrapped OutputAdapter.write with the resolved
 *     credentialId + credentialStore.
 *   - throws OutputChannelMissingChannelIdError when binding config
 *     is missing channel_id.
 *   - throws OutputChannelLookupError when the channel row is
 *     missing from the lookup.
 *   - throws OutputChannelDisabledError when the channel row is
 *     disabled.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { CredentialStore } from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import type {
  OutputAdapter,
  OutputWriteArgs,
  OutputWriteResult,
} from "@opencoo/shared/output-adapter";

import {
  OutputChannelDisabledError,
  OutputChannelLookupError,
  OutputChannelMissingChannelIdError,
  outputAdapterToChannelAdapter,
  type LookupOutputChannel,
  type OutputChannelRecord,
} from "../../src/output-channels/index.js";

interface DummyPayload {
  readonly title: string;
  readonly projectGid: string;
}

const dummyPayloadSchema = z
  .object({ title: z.string(), projectGid: z.string() })
  .strict();

function buildOutputAdapter(
  spy: (args: OutputWriteArgs<DummyPayload>) => void,
): OutputAdapter<DummyPayload> {
  return {
    slug: "asana",
    payloadSchema: dummyPayloadSchema,
    credentialSchema: {
      type: "object",
      properties: {},
    },
    async write(args: OutputWriteArgs<DummyPayload>): Promise<OutputWriteResult> {
      spy(args);
      return { externalId: "task-xyz" };
    },
  };
}

function buildCredentialStore(): CredentialStore {
  return {
    async write() {
      return "cred-x" as CredentialId;
    },
    async read() {
      return {
        name: "x",
        schemaRef: "output-adapter:asana:credentials",
        plaintext: Buffer.from(
          JSON.stringify({ asanaPersonalAccessToken: "1/secret" }),
          "utf8",
        ),
      };
    },
    async rotate() {},
    async delete() {},
  };
}

describe("outputAdapterToChannelAdapter — PR-Z4 bridge", () => {
  it("happy: merges channel config with agent output and writes via OutputAdapter", async () => {
    const writeSpy = vi.fn();
    const outputAdapter = buildOutputAdapter(writeSpy);
    const lookupChannel: LookupOutputChannel = async () => ({
      id: "chan-1",
      adapterSlug: "asana",
      credentialsId: "cred-xyz" as CredentialId,
      config: { project_gid: "PRJ-1" },
      enabled: true,
    });
    const bridge = outputAdapterToChannelAdapter<DummyPayload>({
      outputAdapter,
      lookupChannel,
      credentialStore: buildCredentialStore(),
      mergePayload: ({ channelConfig, agentOutput }) => ({
        title:
          (agentOutput as { summary?: string }).summary ?? "fallback",
        projectGid: String(channelConfig["project_gid"]),
      }),
    });
    await bridge.deliver({
      payload: { summary: "today" },
      config: { channel_id: "chan-1" },
    });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const args = writeSpy.mock.calls[0]![0];
    expect(args.payload).toEqual({ title: "today", projectGid: "PRJ-1" });
    expect(args.credentialId).toBe("cred-xyz");
  });

  it("throws OutputChannelMissingChannelIdError when binding config lacks channel_id", async () => {
    const bridge = outputAdapterToChannelAdapter<DummyPayload>({
      outputAdapter: buildOutputAdapter(() => undefined),
      lookupChannel: async () => null,
      credentialStore: buildCredentialStore(),
      mergePayload: () => ({ title: "x", projectGid: "y" }),
    });
    await expect(
      bridge.deliver({
        payload: {},
        config: {}, // no channel_id
      }),
    ).rejects.toBeInstanceOf(OutputChannelMissingChannelIdError);
  });

  it("throws OutputChannelLookupError when the channel row is missing", async () => {
    const bridge = outputAdapterToChannelAdapter<DummyPayload>({
      outputAdapter: buildOutputAdapter(() => undefined),
      lookupChannel: async () => null,
      credentialStore: buildCredentialStore(),
      mergePayload: () => ({ title: "x", projectGid: "y" }),
    });
    await expect(
      bridge.deliver({
        payload: {},
        config: { channel_id: "ghost" },
      }),
    ).rejects.toBeInstanceOf(OutputChannelLookupError);
  });

  it("throws OutputChannelDisabledError when the channel row is disabled", async () => {
    const disabled: OutputChannelRecord = {
      id: "chan-2",
      adapterSlug: "asana",
      credentialsId: "cred-xyz" as CredentialId,
      config: {},
      enabled: false,
    };
    const bridge = outputAdapterToChannelAdapter<DummyPayload>({
      outputAdapter: buildOutputAdapter(() => undefined),
      lookupChannel: async () => disabled,
      credentialStore: buildCredentialStore(),
      mergePayload: () => ({ title: "x", projectGid: "y" }),
    });
    await expect(
      bridge.deliver({
        payload: {},
        config: { channel_id: "chan-2" },
      }),
    ).rejects.toBeInstanceOf(OutputChannelDisabledError);
  });
});

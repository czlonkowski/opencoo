/**
 * Output-channel error taxonomy. Both errors are
 * errorClass='validation' so a misconfigured delivery DLQs
 * rather than retries — neither a bound-mismatch nor an unknown
 * adapter recovers on retry.
 */
import { OpencooError, type OpencooErrorOptions } from "@opencoo/shared/errors";

/**
 * The delivery's `adapterSlug` is not in the instance's
 * `outputChannelIds[]` binding set. Per Q10 + THREAT-MODEL §3.5:
 * the binding is the closed set; cross-instance leakage is
 * blocked at the registry gate so a prompt-injection attack on
 * the agent cannot smuggle a payload to an unrelated channel.
 */
export class OutputChannelMismatchError extends OpencooError {
  readonly adapterSlug: string;
  readonly allowedSlugs: readonly string[];

  constructor(
    adapterSlug: string,
    allowedSlugs: readonly string[],
    options?: OpencooErrorOptions,
  ) {
    super(
      `output-channels: adapter '${adapterSlug}' is not in this instance's outputChannelIds binding ${JSON.stringify(allowedSlugs)}`,
      "validation",
      options,
    );
    this.name = "OutputChannelMismatchError";
    this.adapterSlug = adapterSlug;
    this.allowedSlugs = [...allowedSlugs];
  }
}

/**
 * The delivery's `adapterSlug` is bound on the instance but no
 * `OutputChannelAdapter` is registered for it — a deployment
 * config bug (the engine boot path failed to register the
 * adapter, or the binding references a removed adapter). DLQ
 * the run; an admin must fix the registry or the binding.
 */
export class OutputChannelUnknownAdapterError extends OpencooError {
  readonly adapterSlug: string;

  constructor(adapterSlug: string, options?: OpencooErrorOptions) {
    super(
      `output-channels: no adapter registered for slug '${adapterSlug}' — engine boot did not register it, or the binding references a removed adapter`,
      "validation",
      options,
    );
    this.name = "OutputChannelUnknownAdapterError";
    this.adapterSlug = adapterSlug;
  }
}

/**
 * PR-Z4 (phase-a appendix #12 G5) — the per-binding config for an
 * `OutputAdapter`-backed channel is missing `channel_id`. The
 * bridge expects `config.channel_id` (uuid) so it can look up the
 * `output_channels` row carrying credentialId + operator config.
 * Validation → DLQ; the operator must re-bind via the Outputs UI.
 */
export class OutputChannelMissingChannelIdError extends OpencooError {
  readonly adapterSlug: string;

  constructor(adapterSlug: string, options?: OpencooErrorOptions) {
    super(
      `output-channels: binding for adapter '${adapterSlug}' is missing config.channel_id — re-bind via the Outputs UI`,
      "validation",
      options,
    );
    this.name = "OutputChannelMissingChannelIdError";
    this.adapterSlug = adapterSlug;
  }
}

/**
 * PR-Z4 — the binding's `channel_id` did not resolve to any
 * `output_channels` row. Dangling reference (the operator
 * deleted the channel without first removing the binding).
 * Validation → DLQ; the operator must either re-create a channel
 * or remove the binding from the instance.
 */
export class OutputChannelLookupError extends OpencooError {
  readonly adapterSlug: string;
  readonly channelId: string;

  constructor(
    adapterSlug: string,
    channelId: string,
    options?: OpencooErrorOptions,
  ) {
    super(
      `output-channels: channel id '${channelId}' (adapter '${adapterSlug}') did not resolve — output_channels row missing or deleted`,
      "validation",
      options,
    );
    this.name = "OutputChannelLookupError";
    this.adapterSlug = adapterSlug;
    this.channelId = channelId;
  }
}

/**
 * PR-Z4 — the resolved channel row is `enabled = false`. The
 * dispatcher could silently skip, but a disabled channel that's
 * still bound on an instance is a config inconsistency the
 * operator should see — validation → DLQ.
 */
export class OutputChannelDisabledError extends OpencooError {
  readonly adapterSlug: string;
  readonly channelId: string;

  constructor(
    adapterSlug: string,
    channelId: string,
    options?: OpencooErrorOptions,
  ) {
    super(
      `output-channels: channel id '${channelId}' (adapter '${adapterSlug}') is disabled — re-enable via the Outputs UI or remove the binding`,
      "validation",
      options,
    );
    this.name = "OutputChannelDisabledError";
    this.adapterSlug = adapterSlug;
    this.channelId = channelId;
  }
}

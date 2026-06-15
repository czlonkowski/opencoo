import { OpencooError, type OpencooErrorOptions } from "../errors.js";

// Policy-layer rejection: the domain's `llm_policy` can't be parsed,
// requests a cloud provider under `local_only:true`, or otherwise
// violates the domain's data-sovereignty constraints. Routed as
// `upstream-quota` (exponential backoff) because config is operator-
// tunable and the caller should let the Review Dashboard surface it
// rather than DLQ.
export class LlmPolicyViolationError extends OpencooError {
  constructor(message: string, options?: OpencooErrorOptions) {
    super(message, "upstream-quota", options);
    this.name = "LlmPolicyViolationError";
  }
}

// Month-to-date cost would exceed the domain's cap. Queues are paused
// as a side-effect of throwing. Same errorClass as policy-violation —
// operators raise the cap via the Review Dashboard, resumption is a
// manual action. DLQ would make ops lose the breach context.
export class LlmBudgetExceededError extends OpencooError {
  constructor(message: string, options?: OpencooErrorOptions) {
    super(message, "upstream-quota", options);
    this.name = "LlmBudgetExceededError";
  }
}

// Provider-side failure that is NOT worth retrying: unregistered mock
// response, malformed/auth-rejected request (4xx), or structured
// output that never satisfies the schema even after repair. Routed as
// `validation` → immediate DLQ. For a genuinely transient upstream
// blip (5xx/429/network) the provider throws `LlmProviderTransientError`
// instead, which is classified by `isRetryableProviderError`.
export class LlmProviderError extends OpencooError {
  constructor(message: string, options?: OpencooErrorOptions) {
    super(message, "validation", options);
    this.name = "LlmProviderError";
  }
}

// Transient provider failure: 5xx / 429 / 408 / 409 / network error.
// Routed as `transient` so the BullMQ retry policy re-attempts with
// backoff instead of DLQ-ing on the first blip. Thrown by the provider
// factories (and the router's bare-error fallback) when
// `isRetryableProviderError` matches.
export class LlmProviderTransientError extends OpencooError {
  constructor(message: string, options?: OpencooErrorOptions) {
    super(message, "transient", options);
    this.name = "LlmProviderTransientError";
  }
}

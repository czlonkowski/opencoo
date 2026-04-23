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

// Provider-side failure: unregistered mock response, network, 5xx,
// JSON shape mismatch on structured output. Routed as `validation`
// so retry logic treats it as a DLQ candidate — the retry shape for
// a genuine provider outage lands with the adapter-layer retry in
// PR 11; this is the default.
export class LlmProviderError extends OpencooError {
  constructor(message: string, options?: OpencooErrorOptions) {
    super(message, "validation", options);
    this.name = "LlmProviderError";
  }
}

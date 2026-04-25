/**
 * Chat-specific error taxonomy. The strict callerPat check
 * (Q2) throws ChatPatRequiredError(validation) when
 * ctx.callerPat is undefined OR whitespace-only — DLQ rather
 * than fall back to a public-scope read.
 */
import { OpencooError, type OpencooErrorOptions } from "@opencoo/shared/errors";

/**
 * The Chat run was invoked without a usable callerPat. The
 * engine HTTP handler's auth layer is supposed to attach the
 * user's gitea PAT; if it didn't, refusing the run is the
 * fail-closed posture. Routed as `validation` so the run DLQs
 * — a missing PAT is a config / auth bug, not retryable.
 */
export class ChatPatRequiredError extends OpencooError {
  constructor(options?: OpencooErrorOptions) {
    super(
      "chat: callerPat is required and must be non-empty — the engine HTTP handler must attach the user's gitea PAT to AgentInvocation.callerPat",
      "validation",
      options,
    );
    this.name = "ChatPatRequiredError";
  }
}

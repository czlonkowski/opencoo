/**
 * Intake-side typed errors. All extend OpencooError so retry policy
 * (errorClass) routes them deterministically: `validation` → DLQ,
 * `transient` → linear backoff, `upstream-quota` → exponential.
 */
import { OpencooError, type OpencooErrorOptions } from "@opencoo/shared/errors";

/**
 * The webhook receiver looked up a binding by id and got nothing,
 * OR the requested adapter slug isn't registered. Both are
 * caller-bug shapes — DLQ at the engine layer, do not retry.
 */
export class AdapterNotFoundError extends OpencooError {
  readonly slug: string;

  constructor(slug: string, options?: OpencooErrorOptions) {
    super(
      `engine-ingestion: no source adapter registered for slug '${slug}'`,
      "validation",
      options,
    );
    this.name = "AdapterNotFoundError";
    this.slug = slug;
  }
}

/**
 * recordIntake / recordWebhook input shape was malformed (empty
 * required string, etc.). Validation tier — caller bug.
 */
export class IntakeValidationError extends OpencooError {
  constructor(message: string, options?: OpencooErrorOptions) {
    super(message, "validation", options);
    this.name = "IntakeValidationError";
  }
}

// Re-export the shared WebhookSignatureError so callers can import
// every intake-tier error from one place.
export { WebhookSignatureError } from "@opencoo/shared/webhook-verifier";

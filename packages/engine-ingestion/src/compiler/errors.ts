/**
 * Compiler error taxonomy. Same shape as the classifier:
 * every compiler failure is `validation` errorClass — the
 * adversarial-LLM threat model treats schema/sentinel/format
 * deviations as poison signals that must DLQ rather than
 * retry against the same model + prompt.
 */

import { OpencooError, type OpencooErrorOptions } from "@opencoo/shared/errors";

/**
 * Schema-strict reject, sentinel scrub failure, frontmatter-
 * injection attempt, or any other compiler-stage validation
 * failure that isn't already covered by a more specific error.
 */
export class CompilerValidationError extends OpencooError {
  constructor(message: string, options?: OpencooErrorOptions) {
    super(message, "validation", options);
    this.name = "CompilerValidationError";
  }
}

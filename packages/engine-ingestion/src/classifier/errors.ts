/**
 * Classifier error taxonomy (THREAT-MODEL §3.4).
 *
 * Every classifier failure is a `validation` error class — the
 * adversarial-LLM threat model treats any deviation from the
 * binding's contract (allowed_paths, allowed_domains, schema)
 * as a poison signal that must DLQ rather than retry. Retrying
 * an adversarial response with the same model + prompt would
 * just re-poison.
 *
 * Sibling guards throw their own subclasses so the orchestrator's
 * caller (Scanner pipeline, PR 16+) can route by `instanceof`
 * for telemetry without losing the union semantics.
 */

import { OpencooError, type OpencooErrorOptions } from "@opencoo/shared/errors";

/**
 * Generic classifier-stage validation failure: Zod-strict rejected
 * the LLM output, the LLM emitted a domain not in `allowed_domains`,
 * or the response could not be parsed as JSON. Path-shape and
 * binding-config violations have their own subclasses below.
 */
export class ClassifierValidationError extends OpencooError {
  constructor(message: string, options?: OpencooErrorOptions) {
    super(message, "validation", options);
    this.name = "ClassifierValidationError";
  }
}

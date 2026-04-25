/**
 * Automation-loop error taxonomy. Builder-side gates throw
 * validation-class errors so a misrouted invocation DLQs
 * rather than retries.
 */
import { OpencooError, type OpencooErrorOptions } from "@opencoo/shared/errors";

/**
 * Builder Gate 2 fired (plan #102 / THREAT-MODEL §7.2.4).
 * `requireApproved(candidate)` was given a candidate whose
 * status is NOT `'approved'`. The Builder can ONLY pick up
 * approved candidates — anything else (proposed, rejected,
 * built, skipped) is either pending operator review, was
 * declined, or is past the build step.
 *
 * Routed as `validation` so the run DLQs — a Builder run
 * scheduled against a non-approved candidate is a config /
 * scheduler bug, not retryable.
 */
export class BuilderGate2Error extends OpencooError {
  readonly candidateId: string;
  readonly observedStatus: string;

  constructor(
    candidateId: string,
    observedStatus: string,
    options?: OpencooErrorOptions,
  ) {
    super(
      `builder Gate 2: candidate ${candidateId} has status '${observedStatus}', expected 'approved' — Builder only runs on operator-approved candidates`,
      "validation",
      options,
    );
    this.name = "BuilderGate2Error";
    this.candidateId = candidateId;
    this.observedStatus = observedStatus;
  }
}

/**
 * Shared error taxonomy for v0.1 reader agents (Heartbeat,
 * Lint). Keys on the same `errorClass` shape as the harness
 * errors so the BullMQ retry machinery (PR 17) treats them
 * uniformly with the rest of engine-self-operating.
 */
import { OpencooError, type OpencooErrorOptions } from "@opencoo/shared/errors";

/**
 * Caller-supplied `domainSlug` does not resolve to a `domains.id`
 * present in `ctx.instance.scopeDomainIds`. Routed as
 * `validation` so the run DLQs — a slug-vs-scope mismatch is a
 * config bug or an attacker-influenced args object, neither of
 * which retry can recover from.
 *
 * Also covers the case where the slug doesn't exist at all
 * (DB returned 0 rows): same outcome — the body cannot run
 * against a domain it can't authorise.
 */
export class DomainScopeMismatchError extends OpencooError {
  readonly domainSlug: string;
  readonly scopeDomainIds: readonly string[];

  constructor(
    domainSlug: string,
    scopeDomainIds: readonly string[],
    options?: OpencooErrorOptions,
  ) {
    super(
      `agent: domainSlug '${domainSlug}' is not within this instance's scopeDomainIds ${JSON.stringify(scopeDomainIds)} — caller is misrouted or the slug does not exist`,
      "validation",
      options,
    );
    this.name = "DomainScopeMismatchError";
    this.domainSlug = domainSlug;
    this.scopeDomainIds = [...scopeDomainIds];
  }
}

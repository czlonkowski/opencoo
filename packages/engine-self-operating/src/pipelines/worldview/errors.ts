/**
 * Worldview pipeline error taxonomy.
 */
import { OpencooError, type OpencooErrorOptions } from "@opencoo/shared/errors";

/**
 * Fired when the worldview body still exceeds the 24,000-byte
 * UTF-8 cap after the one "compress further" retry. Routed as
 * `validation` so the run DLQs — over-cap output is a model-
 * tractable problem operator review can address (or operator
 * lifts the cap), retry won't recover.
 */
export class WorldviewOverflowError extends OpencooError {
  /** Observed bytes of the rejected body, when the pipeline was
   *  able to extract them. `undefined` means "we know it was
   *  over the cap (Zod refinement fired) but we don't have the
   *  raw byte count" — see compile-domain/compile-company for
   *  the source of that limitation. Don't substitute a 0 in
   *  log lines; that misleads operators. */
  readonly attemptedBytes: number | undefined;
  readonly capBytes: number;

  constructor(
    attemptedBytes: number | undefined,
    capBytes: number,
    options?: OpencooErrorOptions,
  ) {
    const attemptedFragment =
      attemptedBytes === undefined
        ? "(attempted bytes unknown)"
        : `(attempted ${attemptedBytes})`;
    super(
      `worldview pipeline: body still exceeds ${capBytes} bytes after retry ${attemptedFragment} — compress further or lift the cap`,
      "validation",
      options,
    );
    this.name = "WorldviewOverflowError";
    this.attemptedBytes = attemptedBytes;
    this.capBytes = capBytes;
  }
}

/**
 * Fired when the company-aggregator pipeline tries to read a
 * non-`worldview.md` path from a non-aggregator domain
 * (sovereignty violation). Defense-in-depth on top of the code
 * structure that's supposed to never form such a request — if
 * a future refactor breaks the structure, this is the runtime
 * tripwire.
 */
export class WorldviewSovereigntyError extends OpencooError {
  readonly domainSlug: string;
  readonly attemptedPath: string;

  constructor(
    domainSlug: string,
    attemptedPath: string,
    options?: OpencooErrorOptions,
  ) {
    super(
      `worldview company-aggregator: attempted to read '${attemptedPath}' from non-aggregator domain '${domainSlug}' — sovereignty constraint allows ONLY 'worldview.md'`,
      "validation",
      options,
    );
    this.name = "WorldviewSovereigntyError";
    this.domainSlug = domainSlug;
    this.attemptedPath = attemptedPath;
  }
}

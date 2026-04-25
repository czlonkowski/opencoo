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
  readonly attemptedBytes: number;
  readonly capBytes: number;

  constructor(
    attemptedBytes: number,
    capBytes: number,
    options?: OpencooErrorOptions,
  ) {
    super(
      `worldview pipeline: body still exceeds ${capBytes} bytes after retry (attempted ${attemptedBytes}) — compress further or lift the cap`,
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

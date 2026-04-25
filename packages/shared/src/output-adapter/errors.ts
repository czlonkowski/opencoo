/**
 * `OutputAdapterError` — taxonomy for OutputAdapter failures.
 * Carries `errorClass` so the BullMQ retry policy keys
 * uniformly across every adapter.
 *
 * Mapping for HTTP-shaped backends (per the brief / plan #115):
 *   - 429 + Retry-After  → `upstream-quota` w/ `retryAfterSeconds`
 *   - 5xx / network drop → `transient`
 *   - 4xx (other)        → `validation` (DLQ; client-side bug)
 *
 * Subclasses constrain `errorClass` so a concrete adapter can
 * `throw new OutputAdapterUpstreamQuotaError(...)` without
 * spelling the class out.
 */
import { OpencooError, type OpencooErrorOptions } from "../errors.js";

export type OutputAdapterErrorClass =
  | "transient"
  | "upstream-quota"
  | "validation";

export interface OutputAdapterErrorOptions extends OpencooErrorOptions {
  /** Only meaningful on `upstream-quota`. The engine's BullMQ
   *  scheduler uses this to defer the retry by AT LEAST this
   *  many seconds (network jitter may add more). v0.1 caps at
   *  600s (10min); anything larger gets clamped at the
   *  scheduler boundary. */
  readonly retryAfterSeconds?: number;
}

export class OutputAdapterError extends OpencooError {
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    errorClass: OutputAdapterErrorClass,
    options?: OutputAdapterErrorOptions,
  ) {
    super(message, errorClass, options);
    this.name = "OutputAdapterError";
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

export class OutputAdapterTransientError extends OutputAdapterError {
  constructor(message: string, options?: OutputAdapterErrorOptions) {
    super(message, "transient", options);
    this.name = "OutputAdapterTransientError";
  }
}

export class OutputAdapterUpstreamQuotaError extends OutputAdapterError {
  constructor(message: string, options?: OutputAdapterErrorOptions) {
    super(message, "upstream-quota", options);
    this.name = "OutputAdapterUpstreamQuotaError";
  }
}

export class OutputAdapterValidationError extends OutputAdapterError {
  constructor(message: string, options?: OutputAdapterErrorOptions) {
    super(message, "validation", options);
    this.name = "OutputAdapterValidationError";
  }
}

/**
 * HTTP status → OutputAdapterError mapping. Concrete adapters
 * call this from their fetch error path. Pulls `Retry-After`
 * from headers when present and parses the seconds form (the
 * shape Asana uses); HTTP-date `Retry-After` values are NOT
 * parsed — `parseRetryAfter` returns `undefined` for those.
 */
export function classifyHttpError(args: {
  readonly status: number;
  readonly retryAfterHeader?: string | null;
  readonly message: string;
  readonly cause?: unknown;
}): OutputAdapterError {
  const baseOptions: OutputAdapterErrorOptions = {};
  if (args.cause !== undefined) {
    Object.assign(baseOptions, { cause: args.cause });
  }
  if (args.status === 429) {
    const seconds = parseRetryAfter(args.retryAfterHeader);
    return new OutputAdapterUpstreamQuotaError(args.message, {
      ...baseOptions,
      ...(seconds !== undefined ? { retryAfterSeconds: seconds } : {}),
    });
  }
  if (args.status >= 500) {
    return new OutputAdapterTransientError(args.message, baseOptions);
  }
  return new OutputAdapterValidationError(args.message, baseOptions);
}

function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

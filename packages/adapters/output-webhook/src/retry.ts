/**
 * Exponential backoff with jitter retry loop for output-webhook (PR-J).
 *
 * # Backoff formula
 *
 *   delayMs = baseDelayMs * 2^attempt + random(0, 250)
 *
 *   - `attempt` is 0-indexed: first attempt = 0, first retry = 1, …
 *   - jitter range [0, 250ms] is fixed (not configurable).
 *   - Delay is applied BEFORE the next attempt (not after failure).
 *
 * # Retry eligibility
 *
 *   - `transient` (5xx / network drop) → retry up to maxAttempts.
 *   - `validation` (4xx other) → DLQ immediately (no retry).
 *   - `upstream-quota` (429) → DLQ immediately (let the BullMQ layer
 *     schedule via retryAfterSeconds on the OutputAdapterError).
 *
 * # Append-only audit
 *
 *   Each attempt writes one `OutputDeliveryRow` via `onDeliveryRow`:
 *   - `transient_failure` rows on retryable failures
 *   - `success` row on 2xx
 *   - `dlq` row on the final failing attempt
 *
 * THREAT-MODEL §2 invariant 8: no UPDATE on prior rows. Only INSERT.
 */
import {
  OutputAdapterTransientError,
  classifyHttpError,
} from "@opencoo/shared/output-adapter";

import type {
  OutputDeliveryRow,
  OutputDeliveryStatus,
  OutputDeliveryWriter,
} from "./output-deliveries-writer.js";
import type { RetryPolicy } from "./binding-config.js";

const JITTER_MAX_MS = 250;

export type SleepFn = (ms: number) => Promise<void>;

export const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface HttpAttemptResult {
  readonly status: number;
  readonly retryAfterHeader: string | null;
  readonly responseBodyExcerpt?: string;
}

export type AttemptFn = () => Promise<HttpAttemptResult>;

export interface RetryLoopArgs {
  readonly deliveryId: string;
  readonly outputBindingId: string;
  readonly policy: RetryPolicy;
  readonly attempt: AttemptFn;
  readonly onDeliveryRow: OutputDeliveryWriter;
  /** Called on terminal DLQ — for the Activity tab alert surface. */
  readonly onDlq?: (args: {
    readonly deliveryId: string;
    readonly error: unknown;
  }) => void;
  readonly sleep: SleepFn;
}

export interface RetryLoopResult {
  /** HTTP status code from the successful response. */
  readonly status: number;
  /** Response body excerpt. */
  readonly responseBodyExcerpt: string | undefined;
}

/**
 * Run the retry loop. Returns on 2xx. Throws `OutputAdapterError` on
 * terminal failure (after all retries, or immediate DLQ).
 */
export async function runRetryLoop(
  args: RetryLoopArgs,
): Promise<RetryLoopResult> {
  const { policy, deliveryId, outputBindingId, onDeliveryRow, onDlq, sleep } =
    args;

  // INSERT one append-only audit row per attempt (THREAT-MODEL §2 invariant 8).
  // `statusCode` and `responseBodyExcerpt` are conditionally included so the
  // DB column stays NULL when the upstream produced no response.
  async function recordAttempt(
    attempt: number,
    sentAt: Date,
    status: OutputDeliveryStatus,
    statusCode: number | undefined,
    responseBodyExcerpt: string | undefined,
  ): Promise<void> {
    const row: OutputDeliveryRow = {
      outputBindingId,
      deliveryId,
      attempt,
      status,
      sentAt,
      completedAt: new Date(),
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(responseBodyExcerpt !== undefined ? { responseBodyExcerpt } : {}),
    };
    await onDeliveryRow(row);
  }

  let lastError: unknown;

  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    const isFinalAttempt = attempt === policy.maxAttempts - 1;

    // Apply backoff BEFORE retries (not before first attempt)
    if (attempt > 0) {
      const delay =
        policy.baseDelayMs * Math.pow(2, attempt - 1) +
        Math.floor(Math.random() * JITTER_MAX_MS);
      await sleep(delay);
    }

    const sentAt = new Date();

    let httpResult: HttpAttemptResult;
    try {
      httpResult = await args.attempt();
    } catch (networkErr) {
      // Network-level error (fetch threw) — treat as transient
      const status: OutputDeliveryStatus = isFinalAttempt
        ? "dlq"
        : "transient_failure";
      await recordAttempt(attempt, sentAt, status, undefined, undefined);

      lastError = new OutputAdapterTransientError(
        `output-webhook: network error on attempt ${attempt}: ${
          networkErr instanceof Error ? networkErr.message : String(networkErr)
        }`,
        { cause: networkErr },
      );

      if (isFinalAttempt) {
        onDlq?.({ deliveryId, error: lastError });
        throw lastError;
      }
      continue;
    }

    const { status, retryAfterHeader, responseBodyExcerpt } = httpResult;

    // 2xx — success
    if (status >= 200 && status < 300) {
      await recordAttempt(attempt, sentAt, "success", status, responseBodyExcerpt);
      return { status, responseBodyExcerpt };
    }

    // Non-2xx: classify the error
    const classifiedError = classifyHttpError({
      status,
      retryAfterHeader,
      message: `output-webhook: HTTP ${status} on attempt ${attempt}`,
    });

    // 429 (upstream-quota) → DLQ immediately (let BullMQ handle retry-after)
    // 4xx (validation) → DLQ immediately (no retry)
    const isRetryable =
      classifiedError.errorClass === "transient" && !isFinalAttempt;
    const rowStatus: OutputDeliveryStatus = isRetryable
      ? "transient_failure"
      : "dlq";

    await recordAttempt(attempt, sentAt, rowStatus, status, responseBodyExcerpt);

    lastError = classifiedError;

    if (!isRetryable) {
      onDlq?.({ deliveryId, error: lastError });
      throw lastError;
    }
  }

  // Should not reach here (loop always returns or throws)
  onDlq?.({ deliveryId, error: lastError });
  throw (
    lastError ??
    new OutputAdapterTransientError(
      "output-webhook: retry loop exhausted without result",
    )
  );
}

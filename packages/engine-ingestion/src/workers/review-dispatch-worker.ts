/**
 * Review Dispatch worker (PR-M1, phase-a appendix #5).
 *
 * Wraps `runReviewDispatcher` (architecture §9 pipeline 4) in a
 * BullMQ Worker bound to the multi-dot queue
 * `ingestion.review.dispatch` (the canonical name exported as
 * `REVIEW_DISPATCH_QUEUE_SLUG`). Construction bypasses
 * `buildEngineWorker` because the slug is dotted.
 *
 * Concurrency 1: the dispatcher is logging-only today; serial
 * processing keeps the audit-log line ordering deterministic.
 */
import {
  Worker,
  type ConnectionOptions,
  type Job,
  type WorkerOptions,
} from "bullmq";

import {
  REVIEW_DISPATCH_QUEUE_SLUG,
  runReviewDispatcher,
  type ReviewDispatchResult,
  type RunReviewDispatcherArgs,
} from "../pipelines/review-dispatcher.js";

export interface ReviewDispatchWorkerDeps {
  readonly logger: RunReviewDispatcherArgs["logger"];
}

/** Pure handler factory — surfaces ValidationError so BullMQ can
 *  route it to the DLQ per the §6.5 retry-classification rules. */
export function buildReviewDispatchHandler(
  deps: ReviewDispatchWorkerDeps,
): (job: Job<unknown>) => Promise<ReviewDispatchResult> {
  return async (job) =>
    runReviewDispatcher({ payload: job.data, logger: deps.logger });
}

export interface StartReviewDispatchWorkerArgs extends ReviewDispatchWorkerDeps {
  readonly connection: ConnectionOptions;
  readonly autorun?: boolean;
}

export function startReviewDispatchWorker(
  args: StartReviewDispatchWorkerArgs,
) {
  const handler = buildReviewDispatchHandler(args);
  const workerOpts: WorkerOptions = {
    connection: args.connection,
    concurrency: 1,
    ...(args.autorun !== undefined ? { autorun: args.autorun } : {}),
  };
  return new Worker<unknown, ReviewDispatchResult>(
    REVIEW_DISPATCH_QUEUE_SLUG,
    handler,
    workerOpts,
  );
}

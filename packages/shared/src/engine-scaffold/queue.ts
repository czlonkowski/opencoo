/**
 * BullMQ queue + worker factories — one queue / worker per
 * pipeline at the convention `<prefix>.<slug>` (architecture.md §6.5
 * DLQ convention; the companion DLQ for `ingestion.scanner` is
 * `ingestion.scanner.dead`).
 *
 * `buildEngineQueue` constructs the producer-side handle.
 * `buildEngineWorker` (PR-M1, phase-a appendix #5) constructs the
 * consumer-side `Worker` so the engine can DEQUEUE jobs the
 * webhook receiver / scanner enqueues — without it, jobs queue up
 * in Redis and nothing dequeues them.
 *
 * Engine-specific helpers wrap these with their own prefix
 * (engine-ingestion: "ingestion"; engine-self-operating: "selfop").
 * Multi-dot queue names (`ingestion.dlq.intake`,
 * `ingestion.scanner.classify`) bypass these helpers — they're
 * constructed via `new Queue(...)` / `new Worker(...)` directly
 * because dotted slugs are rejected here.
 */
import {
  Queue,
  Worker,
  type ConnectionOptions,
  type Job,
  type QueueOptions,
  type WorkerOptions,
} from "bullmq";

export interface BuildEngineQueueOptions {
  readonly connection: ConnectionOptions;
}

/**
 * Construct a BullMQ Queue named `<prefix>.<slug>`. Validates the
 * slug at construction so a malformed input fails loud at boot
 * instead of producing a queue with a degenerate name.
 */
export function buildEngineQueue(
  prefix: string,
  slug: string,
  options: BuildEngineQueueOptions,
): Queue {
  if (prefix.length === 0) {
    throw new Error("buildEngineQueue: prefix must be non-empty");
  }
  if (slug.length === 0) {
    throw new Error("buildEngineQueue: slug must be non-empty");
  }
  if (slug.includes(".")) {
    throw new Error(
      `buildEngineQueue: slug must not contain '.', got ${JSON.stringify(slug)} (the dot is reserved as the prefix separator and would collide with DLQ naming)`,
    );
  }
  const name = `${prefix}.${slug}`;
  const queueOpts: QueueOptions = {
    connection: options.connection,
  };
  return new Queue(name, queueOpts);
}

export interface BuildEngineWorkerOptions {
  readonly connection: ConnectionOptions;
  /** Concurrency cap. Defaults to 1 (BullMQ default), which matches
   *  the per-domain `concurrency: 1` invariant baked into wikiWrite
   *  (architecture.md §16.2). Override per-pipeline only when the
   *  pipeline's correctness genuinely allows parallel jobs. */
  readonly concurrency?: number;
  /** When `false`, the worker is constructed but does NOT auto-start
   *  consuming jobs — caller must invoke `worker.run()` to begin.
   *  Defaults to `true` to match BullMQ's default behaviour. Tests
   *  use `autorun: false` so the worker can be inspected without a
   *  pull loop racing the assertions. */
  readonly autorun?: boolean;
}

/**
 * Construct a BullMQ `Worker` bound to the queue named
 * `<prefix>.<slug>`. Mirrors `buildEngineQueue`'s validation: empty
 * prefix or slug, or any `.` in the slug, fails loud at construction.
 *
 * The handler signature accepts BullMQ's `Job` so callers can read
 * `job.data` (typed via the `JobData` generic) and return a typed
 * result. Errors thrown from the handler propagate to BullMQ, which
 * applies whatever retry policy the producer side configured (per-job
 * `attempts`/`backoff` or the `Queue`'s `defaultJobOptions`) — that
 * policy is NOT this helper's concern.
 */
export function buildEngineWorker<JobData = unknown, JobResult = unknown>(
  prefix: string,
  slug: string,
  handler: (job: Job<JobData>) => Promise<JobResult>,
  options: BuildEngineWorkerOptions,
): Worker<JobData, JobResult> {
  if (prefix.length === 0) {
    throw new Error("buildEngineWorker: prefix must be non-empty");
  }
  if (slug.length === 0) {
    throw new Error("buildEngineWorker: slug must be non-empty");
  }
  if (slug.includes(".")) {
    throw new Error(
      `buildEngineWorker: slug must not contain '.', got ${JSON.stringify(slug)} (the dot is reserved as the prefix separator and would collide with DLQ naming)`,
    );
  }
  const name = `${prefix}.${slug}`;
  const workerOpts: WorkerOptions = {
    connection: options.connection,
    ...(options.concurrency !== undefined
      ? { concurrency: options.concurrency }
      : {}),
    ...(options.autorun !== undefined ? { autorun: options.autorun } : {}),
  };
  return new Worker<JobData, JobResult>(name, handler, workerOpts);
}

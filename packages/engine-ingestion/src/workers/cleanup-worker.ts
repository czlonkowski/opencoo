/**
 * Cleanup worker (PR-M1, phase-a appendix #5).
 *
 * Wraps `runCleanup` (architecture §9 pipeline 6) in a BullMQ
 * Worker bound to `ingestion.cleanup`. Job payload is unused —
 * the cleanup pass operates over every domain.
 *
 * Concurrency 1: cleanup is weekly + global; serial keeps the
 * pruning pass deterministic.
 */
import type { Job } from "bullmq";

import {
  buildEngineWorker,
  type BuildEngineWorkerOptions,
} from "@opencoo/shared/engine-scaffold";

import {
  runCleanup,
  type CleanupResult,
  type RunCleanupArgs,
} from "../pipelines/cleanup.js";

export interface CleanupWorkerDeps {
  readonly db: RunCleanupArgs["db"];
  readonly logger: RunCleanupArgs["logger"];
}

/** Pure handler factory — cleanup ignores the job payload. */
export function buildCleanupHandler(
  deps: CleanupWorkerDeps,
): (job: Job<unknown>) => Promise<CleanupResult> {
  return async (job) => {
    void job; // payload intentionally unused — cleanup operates over every domain
    return runCleanup(deps);
  };
}

export interface StartCleanupWorkerArgs extends CleanupWorkerDeps {
  readonly connection: BuildEngineWorkerOptions["connection"];
  readonly autorun?: boolean;
}

export function startCleanupWorker(args: StartCleanupWorkerArgs) {
  const handler = buildCleanupHandler(args);
  return buildEngineWorker<unknown, CleanupResult>(
    "ingestion",
    "cleanup",
    handler,
    {
      connection: args.connection,
      concurrency: 1,
      ...(args.autorun !== undefined ? { autorun: args.autorun } : {}),
    },
  );
}

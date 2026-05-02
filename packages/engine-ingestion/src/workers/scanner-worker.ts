/**
 * Scanner worker (PR-M1, phase-a appendix #5).
 *
 * Wraps `runScanner` (architecture §9 pipeline 1) in a BullMQ
 * Worker that dequeues from `ingestion.scanner`. The job payload
 * is unused — the scanner enumerates ENABLED bindings each tick
 * and fans out per-binding scans.
 *
 * Concurrency 1: the scanner is rate-limited externally (Drive,
 * Asana). Per-binding parallelism is a v0.2 concern.
 */
import type { Job } from "bullmq";

import {
  buildEngineWorker,
  type BuildEngineWorkerOptions,
} from "@opencoo/shared/engine-scaffold";

import {
  runScanner,
  type RunScannerArgs,
  type ScannerEnqueue,
  type ScannerResult,
  type SourceAdapterRegistry,
} from "../pipelines/scanner.js";
import type { Logger } from "@opencoo/shared/logger";

export interface ScannerWorkerDeps {
  readonly db: RunScannerArgs["db"];
  readonly logger: Logger;
  readonly adapterRegistry: SourceAdapterRegistry;
  readonly enqueue: ScannerEnqueue;
}

/** Pure handler factory — extracted so unit tests can invoke the
 *  wrapper logic without spinning up a real BullMQ Worker. The
 *  job payload is ignored; the scanner enumerates bindings. */
export function buildScannerHandler(
  deps: ScannerWorkerDeps,
): (job: Job<unknown>) => Promise<ScannerResult> {
  return async (job) => {
    void job; // payload intentionally unused — scanner enumerates bindings
    return runScanner(deps);
  };
}

export interface StartScannerWorkerArgs extends ScannerWorkerDeps {
  readonly connection: BuildEngineWorkerOptions["connection"];
  readonly autorun?: boolean;
}

/** Construct + start the scanner worker. Concurrency is hard-pinned
 *  at 1 for v0.1 — see the docstring for rationale. */
export function startScannerWorker(args: StartScannerWorkerArgs) {
  const handler = buildScannerHandler(args);
  return buildEngineWorker<unknown, ScannerResult>(
    "ingestion",
    "scanner",
    handler,
    {
      connection: args.connection,
      concurrency: 1,
      ...(args.autorun !== undefined ? { autorun: args.autorun } : {}),
    },
  );
}

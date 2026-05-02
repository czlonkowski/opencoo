/**
 * Workers public surface (PR-M1, phase-a appendix #5).
 *
 * Five BullMQ Workers — one per ingestion pipeline — with a
 * single boot helper (`startIngestionWorkers`) the engine wires
 * at boot when `mode: 'workers'` is set.
 *
 * Lifecycle-event emission via the optional `IngestionRunEventEmitter`
 * is wired on the BullMQ Worker's `completed` / `failed` events
 * (NOT inside the handler) so emission survives uncaught throws —
 * mirrors the SseBus.bindOutputDlq pattern for output-delivery DLQ
 * events. Error message strings are scrubbed via `scrubPat` before
 * leaving the engine boundary (THREAT-MODEL §3.6 invariant 11).
 */
import type { ConnectionOptions, Worker } from "bullmq";

import { scrubPat } from "@opencoo/shared/scrub";

import {
  startScannerWorker,
  type ScannerWorkerDeps,
} from "./scanner-worker.js";
import {
  startCompileWorker,
  type CompileWorkerDeps,
} from "./compile-worker.js";
import {
  startReviewDispatchWorker,
  type ReviewDispatchWorkerDeps,
} from "./review-dispatch-worker.js";
import {
  startIndexRebuildWorker,
  type IndexRebuildWorkerDeps,
} from "./index-rebuild-worker.js";
import {
  startCleanupWorker,
  type CleanupWorkerDeps,
} from "./cleanup-worker.js";
import type {
  IngestionRunEvent,
  IngestionRunEventEmitter,
  WorkerContext,
} from "./context.js";

export type {
  IngestionRunEvent,
  IngestionRunEventEmitter,
  WorkerContext,
} from "./context.js";

export {
  buildScannerHandler,
  startScannerWorker,
  type ScannerWorkerDeps,
} from "./scanner-worker.js";
export {
  buildCompilationHandler,
  startCompileWorker,
  type CompileWorkerDeps,
} from "./compile-worker.js";
export {
  buildReviewDispatchHandler,
  startReviewDispatchWorker,
  type ReviewDispatchWorkerDeps,
} from "./review-dispatch-worker.js";
export {
  buildIndexRebuildHandler,
  startIndexRebuildWorker,
  type IndexRebuildWorkerDeps,
} from "./index-rebuild-worker.js";
export {
  buildCleanupHandler,
  startCleanupWorker,
  type CleanupWorkerDeps,
} from "./cleanup-worker.js";

/** Default graceful-shutdown drain window. SIGTERM allows BullMQ
 *  to finish in-flight jobs before forcibly disconnecting Redis. */
export const DEFAULT_CLOSE_TIMEOUT_MS = 30_000;

export interface StartIngestionWorkersArgs {
  readonly ctx: WorkerContext;
  readonly connection: ConnectionOptions;
  /** Override compile-worker concurrency (defaults to 2). All
   *  other workers run at concurrency 1. */
  readonly compileConcurrency?: number;
  /** When `false`, Workers are constructed but do NOT start the
   *  background pull loop. Tests rely on this so assertions don't
   *  race against concurrent pulls. Defaults to `true` in
   *  production. */
  readonly autorun?: boolean;
}

export interface IngestionWorkers {
  readonly scanner: Worker;
  readonly compile: Worker;
  readonly reviewDispatch: Worker;
  readonly indexRebuild: Worker;
  readonly cleanup: Worker;
  /** Drain every worker in parallel. Idempotent — subsequent
   *  calls share the in-flight close. */
  closeAll(timeoutMs?: number): Promise<void>;
}

function attachRunEvents(
  worker: Worker,
  definitionSlug: string,
  bus: IngestionRunEventEmitter | undefined,
): void {
  if (bus === undefined) return;
  worker.on("active", (job) => {
    const event: IngestionRunEvent = {
      runId: String(job.id ?? "unknown"),
      definitionSlug,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    bus.emitRunEvent(event);
  });
  worker.on("completed", (job) => {
    const event: IngestionRunEvent = {
      runId: String(job.id ?? "unknown"),
      definitionSlug,
      status: "success",
      startedAt: new Date(job.processedOn ?? Date.now()).toISOString(),
      endedAt: new Date(job.finishedOn ?? Date.now()).toISOString(),
    };
    bus.emitRunEvent(event);
  });
  worker.on("failed", (job, err) => {
    const errorMessage =
      err instanceof Error ? err.message : String(err);
    const event: IngestionRunEvent = {
      runId: String(job?.id ?? "unknown"),
      definitionSlug,
      status: "failed",
      startedAt: new Date(job?.processedOn ?? Date.now()).toISOString(),
      endedAt: new Date().toISOString(),
      errorClass: scrubPat(errorMessage).slice(0, 200),
    };
    bus.emitRunEvent(event);
  });
}

/**
 * Construct + start all five ingestion workers. Returns a typed
 * handle the engine can store and `closeAll` on shutdown.
 *
 * The orchestrator (CLI `serve.ts`) is responsible for SIGTERM
 * → `closeAll` wiring; this function only owns construction.
 */
export function startIngestionWorkers(
  args: StartIngestionWorkersArgs,
): IngestionWorkers {
  const { ctx, connection, autorun } = args;

  // Scanner enqueue: the orchestrator wires the producer-side
  // Queue handle for `ingestion.scanner.classify` here. In test
  // contexts where the adapter registry is empty (see
  // workers.test.ts), enqueue.add is never invoked so a no-op
  // stub is safe.
  const scannerEnqueue: ScannerWorkerDeps["enqueue"] =
    ctx.enqueue ?? {
      async add() {
        throw new Error(
          "scanner-worker: ctx.enqueue is undefined — orchestrator did not wire the ingestion.scanner.classify queue handle",
        );
      },
    };
  const scanner = startScannerWorker({
    db: ctx.db,
    logger: ctx.logger,
    adapterRegistry: ctx.adapterRegistry,
    enqueue: scannerEnqueue,
    connection,
    ...(autorun !== undefined ? { autorun } : {}),
  });

  const compileDeps: CompileWorkerDeps = {
    db: ctx.db,
    logger: ctx.logger,
    router: ctx.router,
    wikiDeps: ctx.wikiDeps,
    author: ctx.author,
    guardAdapter: ctx.guardAdapter,
  };
  const compile = startCompileWorker({
    ...compileDeps,
    connection,
    ...(args.compileConcurrency !== undefined
      ? { concurrency: args.compileConcurrency }
      : {}),
    ...(autorun !== undefined ? { autorun } : {}),
  });

  const reviewDispatchDeps: ReviewDispatchWorkerDeps = {
    logger: ctx.logger,
  };
  const reviewDispatch = startReviewDispatchWorker({
    ...reviewDispatchDeps,
    connection,
    ...(autorun !== undefined ? { autorun } : {}),
  });

  const indexRebuildDeps: IndexRebuildWorkerDeps = {
    logger: ctx.logger,
    wikiDeps: ctx.wikiDeps,
    wikiAdapter: ctx.wikiAdapter,
    author: ctx.author,
  };
  const indexRebuild = startIndexRebuildWorker({
    ...indexRebuildDeps,
    connection,
    ...(autorun !== undefined ? { autorun } : {}),
  });

  const cleanupDeps: CleanupWorkerDeps = {
    db: ctx.db,
    logger: ctx.logger,
  };
  const cleanup = startCleanupWorker({
    ...cleanupDeps,
    connection,
    ...(autorun !== undefined ? { autorun } : {}),
  });

  // Wire SSE run-event emission on every worker. Listener-based
  // (not inside the handler) so emission survives uncaught throws
  // — same pattern as bindOutputDlq in sse-bus.ts.
  attachRunEvents(scanner, "ingestion.scanner", ctx.sseBus);
  attachRunEvents(compile, "ingestion.scanner.classify", ctx.sseBus);
  attachRunEvents(
    reviewDispatch,
    "ingestion.review.dispatch",
    ctx.sseBus,
  );
  attachRunEvents(indexRebuild, "ingestion.index-rebuild", ctx.sseBus);
  attachRunEvents(cleanup, "ingestion.cleanup", ctx.sseBus);

  let closing: Promise<void> | undefined;
  return {
    scanner,
    compile,
    reviewDispatch,
    indexRebuild,
    cleanup,
    closeAll(timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS): Promise<void> {
      if (closing !== undefined) return closing;
      const closes: Promise<void>[] = [
        scanner.close(),
        compile.close(),
        reviewDispatch.close(),
        indexRebuild.close(),
        cleanup.close(),
      ].map((p) =>
        p.catch((err) => {
          // Best-effort: log + swallow so siblings still close.
          ctx.logger.error("ingestion_workers.close_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      );
      closing = Promise.race([
        Promise.all(closes).then(() => undefined),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            ctx.logger.warn("ingestion_workers.close_timeout", {
              timeout_ms: timeoutMs,
            });
            resolve();
          }, timeoutMs),
        ),
      ]);
      return closing;
    },
  };
}

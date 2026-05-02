/**
 * Workers public surface (PR-M1, phase-a appendix #5).
 *
 * Five BullMQ Workers — one per ingestion pipeline — with a
 * single boot helper (`startIngestionWorkers`) the engine wires
 * at boot when `mode: 'workers'` is set. SSE run-event emission
 * lives in `sse-bridge.ts`.
 */
import type { ConnectionOptions, Worker } from "bullmq";

import { startScannerWorker, type ScannerWorkerDeps } from "./scanner-worker.js";
import { startCompileWorker, type CompileWorkerDeps } from "./compile-worker.js";
import {
  startReviewDispatchWorker,
  type ReviewDispatchWorkerDeps,
} from "./review-dispatch-worker.js";
import {
  startIndexRebuildWorker,
  type IndexRebuildWorkerDeps,
} from "./index-rebuild-worker.js";
import { startCleanupWorker, type CleanupWorkerDeps } from "./cleanup-worker.js";
import { attachRunEvents } from "./sse-bridge.js";
import type { WorkerContext } from "./context.js";

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

/** Producer-side enqueue fallback. The orchestrator wires the real
 *  `Queue` handle for `ingestion.scanner.classify` via `ctx.enqueue`;
 *  in the test contexts that omit it (empty adapter registry → the
 *  scanner never calls .add) a throwing stub is safer than silently
 *  dropping jobs in production if the orchestrator forgets the wire. */
const MISSING_ENQUEUE: ScannerWorkerDeps["enqueue"] = {
  async add() {
    throw new Error(
      "scanner-worker: ctx.enqueue is undefined — orchestrator did not wire the ingestion.scanner.classify queue handle",
    );
  },
};

/** Spread an optional field only when defined. Avoids the
 *  `exactOptionalPropertyTypes` clash that `{ x: undefined }` triggers. */
function ifDefined<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
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
  const autorunOpt = ifDefined("autorun", autorun);

  const scanner = startScannerWorker({
    db: ctx.db,
    logger: ctx.logger,
    adapterRegistry: ctx.adapterRegistry,
    enqueue: ctx.enqueue ?? MISSING_ENQUEUE,
    connection,
    ...autorunOpt,
  });

  const compile = startCompileWorker({
    db: ctx.db,
    logger: ctx.logger,
    router: ctx.router,
    wikiDeps: ctx.wikiDeps,
    author: ctx.author,
    guardAdapter: ctx.guardAdapter,
    connection,
    ...ifDefined("concurrency", args.compileConcurrency),
    ...autorunOpt,
  } satisfies CompileWorkerDeps & {
    connection: ConnectionOptions;
    concurrency?: number;
    autorun?: boolean;
  });

  const reviewDispatch = startReviewDispatchWorker({
    logger: ctx.logger,
    connection,
    ...autorunOpt,
  } satisfies ReviewDispatchWorkerDeps & {
    connection: ConnectionOptions;
    autorun?: boolean;
  });

  const indexRebuild = startIndexRebuildWorker({
    logger: ctx.logger,
    wikiDeps: ctx.wikiDeps,
    wikiAdapter: ctx.wikiAdapter,
    author: ctx.author,
    connection,
    ...autorunOpt,
  } satisfies IndexRebuildWorkerDeps & {
    connection: ConnectionOptions;
    autorun?: boolean;
  });

  const cleanup = startCleanupWorker({
    db: ctx.db,
    logger: ctx.logger,
    connection,
    ...autorunOpt,
  } satisfies CleanupWorkerDeps & {
    connection: ConnectionOptions;
    autorun?: boolean;
  });

  // Wire SSE run-event emission on every worker. Listener-based
  // (not inside the handler) so emission survives uncaught throws
  // — same pattern as bindOutputDlq in sse-bus.ts.
  const allWorkers: ReadonlyArray<readonly [Worker, string]> = [
    [scanner, "ingestion.scanner"],
    [compile, "ingestion.scanner.classify"],
    [reviewDispatch, "ingestion.review.dispatch"],
    [indexRebuild, "ingestion.index-rebuild"],
    [cleanup, "ingestion.cleanup"],
  ];
  for (const [worker, slug] of allWorkers) {
    attachRunEvents(worker, slug, ctx.sseBus);
  }

  let closing: Promise<void> | undefined;
  return {
    scanner,
    compile,
    reviewDispatch,
    indexRebuild,
    cleanup,
    closeAll(timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS): Promise<void> {
      if (closing !== undefined) return closing;
      const closes = allWorkers.map(([worker]) =>
        worker.close().catch((err) => {
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

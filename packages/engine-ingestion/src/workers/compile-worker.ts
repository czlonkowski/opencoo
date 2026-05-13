/**
 * Compile worker (PR-M1, phase-a appendix #5).
 *
 * Wraps `runCompilationWorker` (architecture §9 pipeline 2) in a
 * BullMQ Worker that dequeues from the multi-dot queue
 * `ingestion.scanner.classify`. Construction bypasses
 * `buildEngineWorker` (which rejects dotted slugs) and uses
 * `new Worker(...)` directly — same shape as the producer side
 * (`Scanner` in `pipelines/scanner.ts` constructs its `Queue`
 * directly via `new Queue("ingestion.scanner.classify", ...)`).
 *
 * Job payload is the `ScannerClassifyJob` the Scanner emitted.
 * The wrapper unpacks it and threads the stable per-engine
 * dependencies (db, logger, router, wikiDeps, author, guard).
 *
 * Concurrency: configurable, defaults to 2 for v0.1 — the
 * Compilation Worker is the LLM-bound bottleneck; one job per
 * binding-domain at a time is the wikiWrite per-domain
 * `concurrency: 1` invariant (architecture.md §16.2), and the
 * worker can run multiple cross-domain jobs in parallel.
 */
import {
  Worker,
  type ConnectionOptions,
  type Job,
  type WorkerOptions,
} from "bullmq";

import { SCANNER_CLASSIFY_QUEUE_SLUG } from "../pipelines/scanner.js";
import {
  runCompilationWorker,
  type CompilationWorkerResult,
  type RunCompilationWorkerArgs,
} from "../pipelines/compilation-worker.js";
import type { ScannerClassifyJob } from "../pipelines/scanner.js";

export interface CompileWorkerDeps {
  readonly db: RunCompilationWorkerArgs["db"];
  readonly logger: RunCompilationWorkerArgs["logger"];
  readonly router: RunCompilationWorkerArgs["router"];
  readonly wikiDeps: RunCompilationWorkerArgs["wikiDeps"];
  readonly author: RunCompilationWorkerArgs["author"];
  readonly guardAdapter: RunCompilationWorkerArgs["guardAdapter"];
  /** PR-W4 — optional SSE event emitter threaded from WorkerContext.
   *  The compile-worker handler forwards it to `runCompilationWorker`
   *  so failure events surface on the Activity feed live. Optional
   *  for composition-incomplete shapes (test fixtures + headless
   *  runs); production wires the self-op SseBus through here. */
  readonly sseBus?: RunCompilationWorkerArgs["sseBus"];
}

/** Pure handler factory. Threads the stable deps from the
 *  WorkerContext + the per-job ScannerClassifyJob payload.
 *
 *  PR-W4 — `sseBus` is forwarded conditionally so an unset (undefined)
 *  property doesn't trip `exactOptionalPropertyTypes` at the
 *  RunCompilationWorkerArgs seam. */
export function buildCompilationHandler(
  deps: CompileWorkerDeps,
): (job: Job<ScannerClassifyJob>) => Promise<CompilationWorkerResult> {
  return async (job) =>
    runCompilationWorker({
      db: deps.db,
      logger: deps.logger,
      router: deps.router,
      wikiDeps: deps.wikiDeps,
      author: deps.author,
      guardAdapter: deps.guardAdapter,
      ...(deps.sseBus !== undefined ? { sseBus: deps.sseBus } : {}),
      job: job.data,
    });
}

export interface StartCompileWorkerArgs extends CompileWorkerDeps {
  readonly connection: ConnectionOptions;
  readonly concurrency?: number;
  readonly autorun?: boolean;
}

const DEFAULT_COMPILE_CONCURRENCY = 2;

export function startCompileWorker(args: StartCompileWorkerArgs) {
  const handler = buildCompilationHandler(args);
  const workerOpts: WorkerOptions = {
    connection: args.connection,
    concurrency: args.concurrency ?? DEFAULT_COMPILE_CONCURRENCY,
    ...(args.autorun !== undefined ? { autorun: args.autorun } : {}),
  };
  return new Worker<ScannerClassifyJob, CompilationWorkerResult>(
    SCANNER_CLASSIFY_QUEUE_SLUG,
    handler,
    workerOpts,
  );
}

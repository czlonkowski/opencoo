/**
 * Index Rebuild worker (PR-M1, phase-a appendix #5).
 *
 * Wraps `runIndexRebuilder` (architecture §9 pipeline 5) in a
 * BullMQ Worker bound to `ingestion.index-rebuild`. Job payload
 * is `{ domainSlug: string }` — the rebuilder is per-domain.
 *
 * Concurrency 1: the rebuilder writes via wikiWrite which already
 * caps per-domain concurrency at 1; running multiple domains in
 * parallel is fine but PR-M1 keeps it simple — phase-b can lift
 * this if rebuild latency surfaces as a bottleneck.
 */
import type { Job } from "bullmq";

import {
  buildEngineWorker,
  type BuildEngineWorkerOptions,
} from "@opencoo/shared/engine-scaffold";

import {
  runIndexRebuilder,
  type IndexRebuilderResult,
  type RunIndexRebuilderArgs,
} from "../pipelines/index-rebuilder.js";

export interface IndexRebuildWorkerDeps {
  readonly logger: RunIndexRebuilderArgs["logger"];
  readonly wikiDeps: RunIndexRebuilderArgs["wikiDeps"];
  readonly wikiAdapter: RunIndexRebuilderArgs["wikiAdapter"];
  readonly author: RunIndexRebuilderArgs["author"];
}

interface IndexRebuildJob {
  readonly domainSlug: string;
}

function isIndexRebuildJob(value: unknown): value is IndexRebuildJob {
  return (
    typeof value === "object" &&
    value !== null &&
    "domainSlug" in value &&
    typeof (value as { domainSlug: unknown }).domainSlug === "string" &&
    (value as { domainSlug: string }).domainSlug.length > 0
  );
}

/** Pure handler factory. Validates the job payload before
 *  dispatch — index-rebuild is per-domain so a missing slug must
 *  fail loud, not silently rebuild a guessed default. */
export function buildIndexRebuildHandler(
  deps: IndexRebuildWorkerDeps,
): (job: Job<unknown>) => Promise<IndexRebuilderResult> {
  return async (job) => {
    if (!isIndexRebuildJob(job.data)) {
      throw new Error(
        "index-rebuild-worker: job.data must include a non-empty domainSlug",
      );
    }
    return runIndexRebuilder({ ...deps, domainSlug: job.data.domainSlug });
  };
}

export interface StartIndexRebuildWorkerArgs extends IndexRebuildWorkerDeps {
  readonly connection: BuildEngineWorkerOptions["connection"];
  readonly autorun?: boolean;
}

export function startIndexRebuildWorker(
  args: StartIndexRebuildWorkerArgs,
) {
  const handler = buildIndexRebuildHandler(args);
  return buildEngineWorker<unknown, IndexRebuilderResult>(
    "ingestion",
    "index-rebuild",
    handler,
    {
      connection: args.connection,
      concurrency: 1,
      ...(args.autorun !== undefined ? { autorun: args.autorun } : {}),
    },
  );
}

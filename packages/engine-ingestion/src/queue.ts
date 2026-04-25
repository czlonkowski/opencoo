/**
 * Engine-ingestion BullMQ queue helper. Thin wrapper over
 * `buildEngineQueue` from `@opencoo/shared/engine-scaffold` that
 * pins `INGESTION_QUEUE_PREFIX = 'ingestion'` so concrete pipelines
 * call `buildIngestionQueue('scanner', ...)` and get
 * `ingestion.scanner` back (architecture.md §6.5 DLQ convention).
 *
 * Multi-dot queue names (`ingestion.scanner.classify`,
 * `ingestion.dlq.intake`, `ingestion.review.dispatch`) bypass this
 * helper and are constructed via `new Queue(...)` directly because
 * dotted slugs are rejected here.
 */
import type { Queue } from "bullmq";

import {
  buildEngineQueue,
  type BuildEngineQueueOptions,
} from "@opencoo/shared/engine-scaffold";

export const INGESTION_QUEUE_PREFIX = "ingestion" as const;

export type BuildIngestionQueueOptions = BuildEngineQueueOptions;

export function buildIngestionQueue(
  slug: string,
  options: BuildIngestionQueueOptions,
): Queue {
  return buildEngineQueue(INGESTION_QUEUE_PREFIX, slug, options);
}

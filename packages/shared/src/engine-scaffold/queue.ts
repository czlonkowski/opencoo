/**
 * BullMQ queue factory — one queue per pipeline at the convention
 * `<prefix>.<slug>` (architecture.md §6.5 DLQ convention; the
 * companion DLQ for `ingestion.scanner` is `ingestion.scanner.dead`).
 *
 * v0.1 only owns queue construction; concrete pipelines own the
 * worker layer, retry policy, and DLQ wiring.
 *
 * Engine-specific helpers wrap `buildEngineQueue` with their own
 * prefix (engine-ingestion: "ingestion"; engine-self-operating:
 * "selfop"). Multi-dot queue names (`ingestion.dlq.intake`,
 * `ingestion.scanner.classify`) bypass this helper — they're
 * constructed via `new Queue(...)` directly because dotted slugs
 * are rejected here.
 */
import { Queue, type ConnectionOptions, type QueueOptions } from "bullmq";

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

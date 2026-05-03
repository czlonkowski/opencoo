/**
 * Worker → SSE bridge (PR-M1, phase-a appendix #5).
 *
 * Wires `IngestionRunEvent`s onto a BullMQ Worker's `active` /
 * `completed` / `failed` events so the Activity feed shows worker
 * runs alongside output-delivery DLQ events. Listener-based (not
 * inside the handler) so emission survives uncaught throws — same
 * pattern as `bindOutputDlq` in `engine-self-operating`'s sse-bus.
 *
 * `failed` events ship the `Error.message` in the `errorMessage`
 * field — routed through `safeErrorMessage` before leaving the
 * engine boundary (THREAT-MODEL §3.6 invariant 11): scrubbed for
 * credential patterns and capped at 200 chars to keep the SSE
 * frame small. The field is deliberately named `errorMessage`
 * (free text) rather than `errorClass` (the 3-class retry
 * taxonomy on `OpencooError`) so consumers can't confuse the two
 * surfaces.
 */
import type { Worker } from "bullmq";

import { safeErrorMessage } from "@opencoo/shared/scrub";

import type {
  IngestionRunEvent,
  IngestionRunEventEmitter,
} from "./context.js";

/** Wire SSE run-event emission onto a BullMQ Worker. No-op when
 *  `bus` is undefined — keeps the production composition root
 *  free of ceremony when the operator hasn't wired an SSE bus. */
export function attachRunEvents(
  worker: Worker,
  definitionSlug: string,
  bus: IngestionRunEventEmitter | undefined,
): void {
  if (bus === undefined) return;

  worker.on("active", (job) => {
    bus.emitRunEvent({
      runId: String(job.id ?? "unknown"),
      definitionSlug,
      status: "running",
      startedAt: new Date().toISOString(),
    });
  });

  worker.on("completed", (job) => {
    bus.emitRunEvent({
      runId: String(job.id ?? "unknown"),
      definitionSlug,
      status: "success",
      startedAt: new Date(job.processedOn ?? Date.now()).toISOString(),
      endedAt: new Date(job.finishedOn ?? Date.now()).toISOString(),
    });
  });

  worker.on("failed", (job, err) => {
    const event: IngestionRunEvent = {
      runId: String(job?.id ?? "unknown"),
      definitionSlug,
      status: "failed",
      startedAt: new Date(job?.processedOn ?? Date.now()).toISOString(),
      endedAt: new Date().toISOString(),
      errorMessage: safeErrorMessage(err),
    };
    bus.emitRunEvent(event);
  });
}

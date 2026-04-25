/**
 * Pipeline registry — concrete pipelines call `register(definition)`
 * at boot. The harness (`start.ts` in the consuming engine package)
 * iterates `list()` to wire each pipeline to its BullMQ queue +
 * scheduler.
 *
 * Stateful by design (insertion-ordered Map). One instance per
 * engine process; not a singleton — the engine's `start()` owns
 * the instance and passes it through to whatever bootstraps the
 * concrete pipelines.
 */
import type { PipelineDefinition } from "./pipeline.js";

/**
 * Generic over the pipeline definition shape so engine-ingestion
 * (which narrows `PipelineContext` with a `wikiAdapter` field)
 * can store its own narrower `PipelineDefinition` type while
 * still satisfying the base contract. Defaults to the base
 * `PipelineDefinition` for engines that don't extend the context.
 */
export class PipelineRegistry<T extends { name: string } = PipelineDefinition> {
  private readonly byName = new Map<string, T>();

  register(definition: T): void {
    if (this.byName.has(definition.name)) {
      throw new Error(
        `engine-scaffold: duplicate pipeline name '${definition.name}' — registry rejects re-registration`,
      );
    }
    this.byName.set(definition.name, definition);
  }

  get(name: string): T | undefined {
    return this.byName.get(name);
  }

  /** Insertion-order list; downstream consumers (start, smoke
   *  harness) can iterate deterministically. */
  list(): ReadonlyArray<T> {
    return [...this.byName.values()];
  }

  size(): number {
    return this.byName.size;
  }
}

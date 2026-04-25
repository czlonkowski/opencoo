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

export class PipelineRegistry {
  private readonly byName = new Map<string, PipelineDefinition>();

  register(definition: PipelineDefinition): void {
    if (this.byName.has(definition.name)) {
      throw new Error(
        `engine-scaffold: duplicate pipeline name '${definition.name}' — registry rejects re-registration`,
      );
    }
    this.byName.set(definition.name, definition);
  }

  get(name: string): PipelineDefinition | undefined {
    return this.byName.get(name);
  }

  /** Insertion-order list; downstream consumers (start, smoke
   *  harness) can iterate deterministically. */
  list(): ReadonlyArray<PipelineDefinition> {
    return [...this.byName.values()];
  }

  size(): number {
    return this.byName.size;
  }
}

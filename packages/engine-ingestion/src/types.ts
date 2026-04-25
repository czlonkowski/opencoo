/**
 * Engine-ingestion pipeline types — built on the engine-agnostic
 * `PipelineDefinition` + `PipelineContext` from
 * `@opencoo/shared/engine-scaffold`.
 *
 * Ingestion narrows the `PipelineContext` with the ingestion-
 * specific `wikiAdapter` dependency (the Index Rebuilder needs
 * read access; write paths still go through `wikiWrite` from
 * `@opencoo/shared/wiki-write` per the no-direct-gitea-write
 * rule). Engine-self-operating consumes the SAME base type from
 * shared but does NOT add `wikiAdapter` — only ingestion writes
 * to the wiki (THREAT-MODEL §2 invariant 2).
 */
import type { WikiAdapter } from "@opencoo/shared/wiki-write";
import type {
  PipelineContext as BasePipelineContext,
} from "@opencoo/shared/engine-scaffold";

export interface PipelineContext extends BasePipelineContext {
  readonly wikiAdapter: WikiAdapter;
}

/**
 * What a concrete ingestion pipeline contributes. Mirrors the
 * shared `PipelineDefinition` shape but its `run` receives the
 * ingestion-narrowed `PipelineContext`. The two types are
 * structurally compatible — an ingestion pipeline IS a base
 * pipeline whose context happens to carry a wikiAdapter.
 */
export interface PipelineDefinition {
  readonly name: string;
  readonly schedule?: string;
  readonly concurrency?: number;
  run(context: PipelineContext): Promise<void>;
}

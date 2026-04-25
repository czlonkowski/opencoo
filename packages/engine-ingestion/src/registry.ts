/**
 * Engine-ingestion thin re-export of `PipelineRegistry` from
 * `@opencoo/shared/engine-scaffold`. The shared registry is
 * generic over the pipeline definition shape; engine-ingestion
 * uses `PipelineRegistry<PipelineDefinition>` from `./types.js`
 * to thread the ingestion-narrowed PipelineDefinition (which
 * has `wikiAdapter` on its PipelineContext) through.
 */
export { PipelineRegistry } from "@opencoo/shared/engine-scaffold";

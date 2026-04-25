/**
 * Engine-ingestion port surface — `PipelineDefinition` is what
 * concrete pipelines (Scanner, Compiler, Lint, Heartbeat in PRs
 * 14-17) export and register at boot. `PipelineContext` is the
 * dependency bundle a pipeline receives from the engine harness.
 *
 * Both types live here (single file) so PR 14+ pipelines can import
 * them without pulling in the registry / server / queue surface.
 */
import type { Pool } from "pg";
import type { Redis } from "ioredis";

import type { Logger } from "@opencoo/shared/logger";
import type { LlmRouter } from "@opencoo/shared/llm-router";
import type { WikiAdapter } from "@opencoo/shared/wiki-write";

/**
 * What a concrete pipeline contributes. v0.1 keeps the shape
 * deliberately narrow; richer surface (per-pipeline config schema,
 * status reporting, lint hooks) is a v0.2 problem.
 */
export interface PipelineDefinition {
  /** Slug used as the queue name suffix (`ingestion.<name>`). Must
   *  be a stable slug, not a display label — downstream audit /
   *  metrics key on it. */
  readonly name: string;
  /**
   * Optional cron expression. When present, the engine harness
   * schedules the pipeline at this cadence. When absent, the
   * pipeline runs only on explicit enqueue (e.g. webhook trigger).
   */
  readonly schedule?: string;
  /**
   * Optional max-parallel-workers count. Architecture §16.2 calls
   * for concurrency:1 on the per-domain BullMQ queue; the engine
   * harness defaults to 1 when this field is absent.
   */
  readonly concurrency?: number;
  /**
   * Pipeline body. Receives the engine context via DI; never
   * touches process.env or imports `@ai-sdk/*` / wiki-gitea
   * directly (THREAT-MODEL §2 invariants 5 + 2).
   */
  run(context: PipelineContext): Promise<void>;
}

/**
 * Dependency bundle a pipeline receives. Constructed once at engine
 * boot in `start()` and passed to each `run()` invocation.
 *
 * `llmRouter` is optional — pipelines that don't make LLM calls
 * (Scanner, Lint's pure-static-analysis pass) leave it unset; the
 * engine harness fills it in only when at least one registered
 * pipeline declares it needs LLM.
 */
export interface PipelineContext {
  readonly db: Pool;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly wikiAdapter: WikiAdapter;
  readonly llmRouter?: LlmRouter;
}

// Public surface for `@opencoo/shared/engine-scaffold` (PR 18,
// plan #82). Both engine-ingestion and engine-self-operating
// consume this module instead of duplicating the boot path.

export {
  BaseEngineConfigSchema,
  EngineLogLevelSchema,
  EngineNodeEnvSchema,
  parseEngineConfig,
  parseEnginePort,
  readWithFile,
  requireWithFile,
  type BaseEngineConfig,
  type ParseEngineConfigOptions,
} from "./config.js";

export {
  buildEngineQueue,
  buildEngineWorker,
  type BuildEngineQueueOptions,
  type BuildEngineWorkerOptions,
} from "./queue.js";

export {
  PipelineRegistry,
} from "./registry.js";

export {
  type PipelineContext,
  type PipelineDefinition,
} from "./pipeline.js";

export {
  buildServer,
  type BuildServerOptions,
  type ProbeFn,
  type ProbeMap,
} from "./server.js";

export {
  postgresProbe,
  type PostgresProbeTarget,
} from "./probes/postgres.js";

export {
  redisProbe,
  type RedisProbeTarget,
} from "./probes/redis.js";

export type { ProbeResult } from "./probes/types.js";

export {
  startEngine,
  type StartConfig,
  type StartDb,
  type StartedEngine,
  type StartOptions,
  type StartRedis,
  type StartServer,
} from "./start.js";

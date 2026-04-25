/**
 * Engine-ingestion entrypoint. Thin wrapper over `startEngine`
 * from `@opencoo/shared/engine-scaffold` that wires in production
 * defaults for `pg.Pool` + `ioredis.Redis` and types the registry
 * to ingestion's narrowed `PipelineDefinition` (which carries a
 * `wikiAdapter` on its `PipelineContext`).
 *
 * Production defaults construct real pg.Pool / ioredis Redis;
 * tests inject stubs via `dbFactory` / `redisFactory` /
 * `serverFactory`.
 *
 * BullMQ requirement: when ioredis is used as the BullMQ
 * connection, `maxRetriesPerRequest: null` and
 * `enableReadyCheck: false` must be set — the default factory
 * here applies both.
 */
import pg from "pg";
import { Redis } from "ioredis";

import {
  PipelineRegistry,
  startEngine,
  type StartDb,
  type StartedEngine as BaseStartedEngine,
  type StartOptions as BaseStartOptions,
  type StartRedis,
} from "@opencoo/shared/engine-scaffold";

import { loadEngineConfig, type EngineConfig } from "./config.js";
import type { PipelineDefinition } from "./types.js";

export type IngestionRegistry = PipelineRegistry<PipelineDefinition>;
export type StartedEngine = BaseStartedEngine<EngineConfig, IngestionRegistry>;

// Re-exports so callers can construct the typed registry + pass
// it to `start()` from one import.
export { PipelineRegistry } from "@opencoo/shared/engine-scaffold";
export type {
  ProbeMap,
  StartDb,
  StartRedis,
  StartServer,
} from "@opencoo/shared/engine-scaffold";

export interface StartOptions
  extends Omit<
    BaseStartOptions<EngineConfig, IngestionRegistry>,
    "config" | "dbFactory" | "redisFactory"
  > {
  /** Optional override of process.env — keeps `start()` testable
   *  by injecting a stub env without polluting the real one. */
  readonly env?: Record<string, string | undefined>;
  /** Optional override of the EngineConfig — bypasses
   *  `loadEngineConfig(env)` when set, useful for tests that
   *  build a full config without env-var plumbing. */
  readonly config?: EngineConfig;
  /** @internal Test seam — defaults to `new pg.Pool(...)`. */
  readonly dbFactory?: (config: EngineConfig) => StartDb;
  /** @internal Test seam — defaults to `new Redis(...)`. */
  readonly redisFactory?: (config: EngineConfig) => StartRedis;
}

function defaultDbFactory(config: EngineConfig): StartDb {
  return new pg.Pool({ connectionString: config.databaseUrl });
}

function defaultRedisFactory(config: EngineConfig): StartRedis {
  return new Redis(config.redisUrl, {
    // BullMQ requirement.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

export async function start(
  options: StartOptions = {},
): Promise<StartedEngine> {
  const config =
    options.config ?? loadEngineConfig(options.env ?? process.env);
  const baseOptions: BaseStartOptions<EngineConfig, IngestionRegistry> = {
    config,
    dbFactory: options.dbFactory ?? defaultDbFactory,
    redisFactory: options.redisFactory ?? defaultRedisFactory,
    ...(options.registry !== undefined ? { registry: options.registry } : {}),
    ...(options.serverFactory !== undefined
      ? { serverFactory: options.serverFactory }
      : {}),
    ...(options.probeExtender !== undefined
      ? { probeExtender: options.probeExtender }
      : {}),
  };
  return startEngine<EngineConfig, IngestionRegistry>(baseOptions);
}

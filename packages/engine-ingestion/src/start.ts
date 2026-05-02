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
import type { ConnectionOptions } from "bullmq";

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
import {
  startIngestionWorkers,
  type IngestionWorkers,
  type WorkerContext,
} from "./workers/index.js";

export type IngestionRegistry = PipelineRegistry<PipelineDefinition>;

/** v0.1 mode flag (PR-M1, phase-a appendix #5).
 *
 *  - `'probes-only'` (default): the engine starts the Fastify
 *     listener with health/ready probes. No BullMQ Workers are
 *     constructed — useful for the plan #82 boot path before
 *     workers existed, plus every pre-PR-M1 test.
 *  - `'workers'`: in addition to probes, all five BullMQ Workers
 *     are booted and bound to the queues the webhook receiver +
 *     scanner enqueue onto. The orchestrator (CLI `serve.ts`)
 *     uses this mode in production.
 */
export type IngestionStartMode = "probes-only" | "workers";

export type StartedEngine = BaseStartedEngine<
  EngineConfig,
  IngestionRegistry
> & {
  /** Present iff `mode === 'workers'`. The orchestrator may
   *  invoke `workers.closeAll()` ahead of `engine.close()` for
   *  finer-grained shutdown ordering. */
  readonly workers?: IngestionWorkers;
};

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
  /**
   * v0.1 NO-OP forward-compat flag (PR 30 / plan #135 decision Q4).
   *
   * Engines do NOT auto-migrate at boot in v0.1 — the operator
   * runs `opencoo migrate` explicitly per the runbook. This
   * flag is reserved for v0.2 if auto-migrate is added: setting
   * it to `true` will skip the v0.2 auto-migrate step. Today,
   * passing it has no effect — the field exists so the CLI's
   * `--skip-migrate` flag wiring (PR 30 `start` command, when
   * added in a future PR) doesn't fail to type-check.
   */
  readonly skipMigrate?: boolean;
  /** Boot mode (PR-M1, phase-a appendix #5). Defaults to
   *  `'probes-only'`. When set to `'workers'`, the engine boots
   *  all five BullMQ Workers AFTER the Fastify listener is up,
   *  using the supplied `workerContext` (which the orchestrator
   *  populates with the shared db/Redis/SseBus). */
  readonly mode?: IngestionStartMode;
  /** Required when `mode === 'workers'`. The orchestrator
   *  constructs this once at boot and threads it down. Holds
   *  the production WikiAdapter, GuardAdapter, LlmRouter, etc.
   *  Optional in `probes-only` mode. */
  readonly workerContext?: WorkerContext;
  /** Required when `mode === 'workers'`. The shared BullMQ
   *  connection — same Redis instance the queues use. Typically
   *  `{ url: config.redisUrl, maxRetriesPerRequest: null,
   *  enableReadyCheck: false }`. */
  readonly workerConnection?: ConnectionOptions;
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

  const mode: IngestionStartMode = options.mode ?? "probes-only";

  // Validate workers-mode prerequisites BEFORE constructing the
  // engine. A missing workerContext at this point is a
  // composition-root bug — fail loud at boot, don't lazy-discover
  // it on the first dequeue.
  if (mode === "workers") {
    if (options.workerContext === undefined) {
      throw new Error(
        "engine-ingestion start: mode='workers' requires options.workerContext (orchestrator must construct the WorkerContext and pass it in)",
      );
    }
    if (options.workerConnection === undefined) {
      throw new Error(
        "engine-ingestion start: mode='workers' requires options.workerConnection (shared BullMQ connection)",
      );
    }
  }

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
  const baseEngine = await startEngine<EngineConfig, IngestionRegistry>(
    baseOptions,
  );

  if (mode === "probes-only") {
    return baseEngine;
  }

  // mode === 'workers' — boot all five Workers and bind them to
  // the shared Redis connection. Validated above.
  const workers = startIngestionWorkers({
    ctx: options.workerContext as WorkerContext,
    connection: options.workerConnection as ConnectionOptions,
  });

  // Wrap close() so SIGTERM drains workers BEFORE the HTTP
  // listener / pg pool / Redis go away. closeAll() is idempotent
  // internally; baseEngine.close() also memoises so double-close
  // here is safe.
  const baseClose = baseEngine.close.bind(baseEngine);
  return {
    ...baseEngine,
    workers,
    async close(): Promise<void> {
      await workers.closeAll();
      await baseClose();
    },
  };
}

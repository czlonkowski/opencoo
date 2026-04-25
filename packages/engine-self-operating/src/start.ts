/**
 * Engine-self-operating entrypoint. Thin wrapper over `startEngine`
 * from `@opencoo/shared/engine-scaffold` that wires:
 *   - production-default pg.Pool + ioredis Redis factories,
 *   - a server factory that registers the Static UI middleware
 *     (Q4–Q6: bundled SPA + boot-tolerant + heuristic fallback)
 *     after the standard /health + /ready routes.
 *
 * BullMQ requirement: when ioredis is used as the BullMQ
 * connection, `maxRetriesPerRequest: null` and
 * `enableReadyCheck: false` must be set — the default factory
 * applies both. (engine-self-operating doesn't ship pipelines
 * in v0.1, but the harness shape stays in lockstep with
 * engine-ingestion so a v0.2 self-op pipeline can land without
 * boot-path churn.)
 */
import pg from "pg";
import { Redis } from "ioredis";
import type { FastifyInstance } from "fastify";

import { ConsoleLogger, type Logger } from "@opencoo/shared/logger";
import {
  PipelineRegistry,
  buildServer,
  startEngine,
  type ProbeMap,
  type StartDb,
  type StartedEngine as BaseStartedEngine,
  type StartOptions as BaseStartOptions,
  type StartRedis,
  type StartServer,
} from "@opencoo/shared/engine-scaffold";

import { loadEngineConfig, type EngineConfig } from "./config.js";
import { registerStaticUi } from "./static-ui.js";

export type SelfOperatingRegistry = PipelineRegistry;
export type StartedEngine = BaseStartedEngine<EngineConfig, SelfOperatingRegistry>;

export { PipelineRegistry } from "@opencoo/shared/engine-scaffold";
export type {
  ProbeMap,
  StartDb,
  StartRedis,
  StartServer,
} from "@opencoo/shared/engine-scaffold";

export interface StartOptions
  extends Omit<
    BaseStartOptions<EngineConfig, SelfOperatingRegistry>,
    "config" | "dbFactory" | "redisFactory" | "serverFactory"
  > {
  /** Optional override of process.env. */
  readonly env?: Record<string, string | undefined>;
  /** Optional pre-built EngineConfig — bypasses loadEngineConfig. */
  readonly config?: EngineConfig;
  /** Optional logger override; defaults to a ConsoleLogger writing
   *  to process.stdout. */
  readonly logger?: Logger;
  /** @internal Test seam — defaults to pg.Pool. */
  readonly dbFactory?: (config: EngineConfig) => StartDb;
  /** @internal Test seam — defaults to ioredis Redis. */
  readonly redisFactory?: (config: EngineConfig) => StartRedis;
  /** @internal Test seam — receives the probe map and the resolved
   *  config so the server factory can wire the static UI from the
   *  config's uiDistPath. Defaults to a Fastify app via buildServer
   *  with the static UI registered. */
  readonly serverFactory?: (
    probes: ProbeMap,
    config: EngineConfig,
    logger: Logger,
  ) => Promise<StartServer> | StartServer;
}

function defaultDbFactory(config: EngineConfig): StartDb {
  return new pg.Pool({ connectionString: config.databaseUrl });
}

function defaultRedisFactory(config: EngineConfig): StartRedis {
  return new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

async function defaultServerFactory(
  probes: ProbeMap,
  config: EngineConfig,
  logger: Logger,
): Promise<StartServer> {
  const app: FastifyInstance = buildServer({ probes });
  await registerStaticUi(app, {
    ...(config.uiDistPath !== undefined ? { uiDistPath: config.uiDistPath } : {}),
    logger,
  });
  return app as unknown as FastifyInstance & StartServer;
}

export async function start(
  options: StartOptions = {},
): Promise<StartedEngine> {
  const config =
    options.config ?? loadEngineConfig(options.env ?? process.env);
  const logger = options.logger ?? new ConsoleLogger();

  // The shared `startEngine` awaits its serverFactory return, so we
  // pass our async factory directly — no sync shim required.
  const userServerFactory = options.serverFactory ?? defaultServerFactory;
  const serverFactory = (
    probes: ProbeMap,
  ): Promise<StartServer> | StartServer =>
    userServerFactory(probes, config, logger);

  const baseOptions: BaseStartOptions<EngineConfig, SelfOperatingRegistry> = {
    config,
    dbFactory: options.dbFactory ?? defaultDbFactory,
    redisFactory: options.redisFactory ?? defaultRedisFactory,
    serverFactory,
    ...(options.registry !== undefined ? { registry: options.registry } : {}),
    ...(options.probeExtender !== undefined
      ? { probeExtender: options.probeExtender }
      : {}),
  };
  return startEngine<EngineConfig, SelfOperatingRegistry>(baseOptions);
}

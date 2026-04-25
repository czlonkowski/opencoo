/**
 * Engine entrypoint helper — wires DB pool → Redis client →
 * probe map → Fastify server, listens on the configured port,
 * and returns a `StartedEngine` with an idempotent `close()`.
 *
 * v0.1 contract (shared across both engines):
 *   - construct pg.Pool, ioredis.Redis (via injected factories)
 *   - build probe map { postgres, redis }
 *   - build Fastify app with /health + /ready
 *   - listen on the configured port
 *   - return { app, db, redis, registry, close }
 *
 * Concrete pipelines call `registry.register(...)` before invoking
 * `start()`. Wiring of pipelines to BullMQ workers happens inside
 * the engine package; this module only owns the BOOT path.
 *
 * Test seam: `dbFactory` / `redisFactory` / `serverFactory` let
 * unit tests inject stubs without dialing real services.
 *
 * Resource safety: if `app.listen()` throws (EADDRINUSE, EACCES,
 * etc.) AFTER db + redis are constructed, both are torn down
 * best-effort before the original error rethrows. Cleanup errors
 * don't mask the listen error.
 *
 * Idempotent close: `close()` memoises its first invocation;
 * concurrent or repeat calls share the same Promise so cleanup
 * runs exactly once.
 */
import type { FastifyInstance } from "fastify";

import { buildServer, type ProbeMap } from "./server.js";
import {
  postgresProbe,
  type PostgresProbeTarget,
} from "./probes/postgres.js";
import {
  redisProbe,
  type RedisProbeTarget,
} from "./probes/redis.js";
import { PipelineRegistry } from "./registry.js";

/** Subset of `pg.Pool` start() actually consumes. Lets test stubs
 *  satisfy the type without faking the full Pool surface. */
export interface StartDb extends PostgresProbeTarget {
  end(): Promise<void>;
}

/** Subset of `ioredis.Redis` start() actually consumes. */
export interface StartRedis extends RedisProbeTarget {
  disconnect(): void;
}

/** Subset of `FastifyInstance` start() consumes — listen + close.
 *  Production defaults to a full Fastify instance. */
export interface StartServer {
  listen(opts: { host: string; port: number }): Promise<unknown>;
  close(): Promise<void>;
}

/** Minimum config shape `start()` requires. Each engine's full
 *  config extends this; engine-specific fields ride along
 *  unmodified through the generic. */
export interface StartConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly port: number;
}

export interface StartedEngine<
  TConfig extends StartConfig,
  TRegistry extends PipelineRegistry<{ name: string }> = PipelineRegistry,
> {
  readonly app: StartServer;
  readonly db: StartDb;
  readonly redis: StartRedis;
  readonly registry: TRegistry;
  readonly config: TConfig;
  /** Tear down the engine: close the HTTP server, drain the pool,
   *  disconnect Redis. Idempotent — safe to call repeatedly or
   *  concurrently; the first invocation runs cleanup once and
   *  subsequent callers receive the same Promise. */
  close(): Promise<void>;
}

export interface StartOptions<
  TConfig extends StartConfig,
  TRegistry extends PipelineRegistry<{ name: string }> = PipelineRegistry,
> {
  readonly config: TConfig;
  /** Optional pre-populated registry — concrete pipelines register
   *  before calling `start()`. Engine packages that narrow their
   *  PipelineDefinition pass their own typed registry instance. */
  readonly registry?: TRegistry;
  readonly dbFactory: (config: TConfig) => StartDb;
  readonly redisFactory: (config: TConfig) => StartRedis;
  /** Optional probe-map extender. Receives the default {postgres,
   *  redis} probes and may return an extended map (e.g. self-op
   *  could add `wikiAdapter` later). When undefined the defaults
   *  are used as-is. */
  readonly probeExtender?: (probes: ProbeMap) => ProbeMap;
  /** @internal Test seam — defaults to `buildServer({probes})`.
   *  Accepts an async factory so engines that need async plugin
   *  registration (engine-self-operating's static-UI plugin)
   *  don't have to bridge through a synchronous shim. */
  readonly serverFactory?: (
    probes: ProbeMap,
  ) => StartServer | Promise<StartServer>;
}

function defaultServerFactory(probes: ProbeMap): StartServer {
  // FastifyInstance is structurally compatible with StartServer —
  // both expose listen + close with the same shape.
  return buildServer({ probes }) as unknown as FastifyInstance & StartServer;
}

/**
 * Best-effort cleanup. Each step swallows its own error so a
 * buggy pool.end doesn't prevent redis.disconnect from running.
 * The caller (start's catch block) is responsible for rethrowing
 * the ORIGINAL error that triggered teardown.
 */
async function teardown(
  app: StartServer | undefined,
  db: StartDb | undefined,
  redis: StartRedis | undefined,
): Promise<void> {
  if (app !== undefined) {
    try {
      await app.close();
    } catch {
      /* best-effort */
    }
  }
  if (db !== undefined) {
    try {
      await db.end();
    } catch {
      /* best-effort */
    }
  }
  if (redis !== undefined) {
    try {
      redis.disconnect();
    } catch {
      /* best-effort */
    }
  }
}

export async function startEngine<
  TConfig extends StartConfig,
  TRegistry extends PipelineRegistry<{ name: string }> = PipelineRegistry,
>(
  options: StartOptions<TConfig, TRegistry>,
): Promise<StartedEngine<TConfig, TRegistry>> {
  const registry =
    options.registry ?? (new PipelineRegistry() as unknown as TRegistry);
  const db = options.dbFactory(options.config);
  const redis = options.redisFactory(options.config);

  const baseProbes: ProbeMap = {
    postgres: () => postgresProbe(db),
    redis: () => redisProbe(redis),
  };
  const probes =
    options.probeExtender !== undefined
      ? options.probeExtender(baseProbes)
      : baseProbes;

  const app = await (options.serverFactory ?? defaultServerFactory)(probes);

  try {
    await app.listen({ host: "0.0.0.0", port: options.config.port });
  } catch (err) {
    await teardown(app, db, redis);
    throw err;
  }

  let closing: Promise<void> | undefined;

  return {
    app,
    db,
    redis,
    registry,
    config: options.config,
    close(): Promise<void> {
      if (closing === undefined) {
        closing = teardown(app, db, redis);
      }
      return closing;
    },
  };
}

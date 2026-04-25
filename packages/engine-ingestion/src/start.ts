/**
 * Engine entrypoint — wires config → DB pool → Redis client →
 * probe map → Fastify server, and exposes hooks for concrete
 * pipelines to register at boot. Returns IMMEDIATELY (per Q12);
 * the reverse proxy gates traffic via /ready until probes pass,
 * so we do not block startup on probe-retry loops.
 *
 * v0.1 contract:
 *   - load config (throws on misconfig — fail-fast at boot)
 *   - construct pg.Pool, ioredis.Redis
 *   - build probe map { postgres, redis }
 *   - build Fastify app with /health + /ready
 *   - listen on the configured port
 *   - return { app, db, redis, registry, close }
 *
 * Concrete pipelines (PRs 14-17) call `registry.register(...)`
 * before invoking `start()`. Wiring of pipelines to BullMQ workers
 * happens inside start() but the worker class itself ships with
 * the concrete pipeline PRs.
 */
import pg from "pg";
import { Redis } from "ioredis";

import { loadEngineConfig, type EngineConfig } from "./config.js";
import { postgresProbe } from "./probes/postgres.js";
import { redisProbe } from "./probes/redis.js";
import { PipelineRegistry } from "./registry.js";
import { buildServer, type ProbeMap } from "./server.js";
import type { FastifyInstance } from "fastify";

export interface StartedEngine {
  readonly app: FastifyInstance;
  readonly db: pg.Pool;
  readonly redis: Redis;
  readonly registry: PipelineRegistry;
  readonly config: EngineConfig;
  /** Tear down the engine: close the HTTP server, drain the pool,
   *  disconnect Redis. Idempotent. */
  close(): Promise<void>;
}

export interface StartOptions {
  /** Optional override of process.env — keeps `start()` testable
   *  by injecting a stub env without polluting the real one. */
  readonly env?: Record<string, string | undefined>;
  /** Optional pre-populated registry — concrete pipelines register
   *  before calling `start()`. */
  readonly registry?: PipelineRegistry;
}

export async function start(options: StartOptions = {}): Promise<StartedEngine> {
  const config = loadEngineConfig(options.env ?? process.env);
  const registry = options.registry ?? new PipelineRegistry();

  const db = new pg.Pool({ connectionString: config.databaseUrl });
  const redis = new Redis(config.redisUrl, {
    // BullMQ requirement — when ioredis is used as the BullMQ
    // connection, maxRetriesPerRequest must be null and
    // enableReadyCheck must be false.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  const probes: ProbeMap = {
    postgres: () => postgresProbe(db),
    redis: () => redisProbe(redis),
  };

  const app = buildServer({ probes });
  await app.listen({ host: "0.0.0.0", port: config.port });

  return {
    app,
    db,
    redis,
    registry,
    config,
    async close() {
      await app.close();
      await db.end();
      redis.disconnect();
    },
  };
}

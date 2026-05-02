/**
 * Engine-self-operating entrypoint. Thin wrapper over `startEngine`
 * from `@opencoo/shared/engine-scaffold` that wires:
 *   - production-default pg.Pool + ioredis Redis factories,
 *   - a server factory that registers the admin-API (when the
 *     PR 28 env vars are set) AND the Static UI middleware.
 *     Order matters: admin-API → static-UI so the
 *     setNotFoundHandler doesn't catch unknown `/api/admin/*`
 *     paths (verified by `tests/composition/server-factory.test.ts`).
 *
 * BullMQ requirement: when ioredis is used as the BullMQ
 * connection, `maxRetriesPerRequest: null` and
 * `enableReadyCheck: false` must be set — the default factory
 * applies both. (engine-self-operating doesn't ship pipelines
 * in v0.1, but the harness shape stays in lockstep with
 * engine-ingestion so a v0.2 self-op pipeline can land without
 * boot-path churn.)
 *
 * # Production wiring (PR 30)
 *
 * When `ADMIN_TEAM_SLUG` + `SESSION_HMAC_KEY` + `GITEA_BASE_URL`
 * are all set, `start()` constructs a real fetch-based
 * `GiteaClient`, instantiates the admin-API plugin, and
 * registers it BEFORE the static-ui plugin. When any of those
 * env vars are missing, the engine STILL BOOTS — but with the
 * admin-API disabled and a clear `admin_api.disabled` log line
 * pointing the operator at the missing env var. This boot-
 * tolerant behavior matches PR 18's UI_DIST_PATH treatment.
 */
import pg from "pg";
import { Redis } from "ioredis";
import type { FastifyInstance } from "fastify";

import {
  DrizzleCredentialStore,
  loadEncryptionKey,
} from "@opencoo/shared/credential-store";
import { ConsoleLogger, type Logger } from "@opencoo/shared/logger";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  PipelineRegistry,
  buildEngineQueue,
  buildServer,
  startEngine,
  type ProbeMap,
  type StartDb,
  type StartedEngine as BaseStartedEngine,
  type StartOptions as BaseStartOptions,
  type StartRedis,
  type StartServer,
} from "@opencoo/shared/engine-scaffold";

import type { GiteaClient } from "./admin-api/auth.js";
import {
  loadAdminApiCompositionEnv,
  type AdminApiCompositionEnv,
} from "./composition/env.js";
import { createGiteaClient } from "./composition/gitea-client.js";
import { productionServerFactory } from "./composition/server-factory.js";
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
   *  with the static UI registered (PLUS admin-API in production
   *  when the env vars are set). */
  readonly serverFactory?: (
    probes: ProbeMap,
    config: EngineConfig,
    logger: Logger,
  ) => Promise<StartServer> | StartServer;
  /** @internal Test seam — defaults to `createGiteaClient`. Used
   *  by composition tests to substitute a mock client without
   *  the env-var dance. */
  readonly giteaClientFactory?: (baseUrl: string) => GiteaClient;
  /**
   * v0.1 NO-OP forward-compat flag (PR 30 / plan #135 decision Q4).
   * Engines do NOT auto-migrate at boot — the operator runs
   * `opencoo migrate` explicitly. Reserved for v0.2.
   */
  readonly skipMigrate?: boolean;
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

/**
 * Static-UI-only server factory. Used when:
 *   - the operator hasn't set the admin-API env vars (boot-
 *     tolerant fallback),
 *   - tests inject this directly via `options.serverFactory`.
 */
async function staticUiOnlyServerFactory(
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

/** Try to load the admin-API env. Returns `null` (and logs)
 *  when any required var is missing — boot continues with the
 *  static-UI-only factory. */
function tryLoadAdminApiEnv(
  env: Record<string, string | undefined>,
  logger: Logger,
): AdminApiCompositionEnv | null {
  try {
    return loadAdminApiCompositionEnv(env);
  } catch (err) {
    logger.warn("admin_api.disabled", {
      reason:
        "ADMIN_TEAM_SLUG / SESSION_HMAC_KEY / GITEA_BASE_URL not all set; admin API will not register",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function start(
  options: StartOptions = {},
): Promise<StartedEngine> {
  const env = options.env ?? process.env;
  const config = options.config ?? loadEngineConfig(env);
  const logger = options.logger ?? new ConsoleLogger();

  // Pre-construct the pg.Pool here so we can pass it to BOTH
  // the scaffold's dbFactory (which returns the pool to the
  // engine harness) AND the production serverFactory (which
  // hands the pool to the admin-API + audit-log writers).
  // Reusing the SAME pool matters: a second pool would double
  // the connection count and run a parallel auth handshake.
  const dbFactoryFromOptions = options.dbFactory;
  const pgPool: pg.Pool | null =
    dbFactoryFromOptions === undefined
      ? new pg.Pool({ connectionString: config.databaseUrl })
      : null;
  const dbFactory: (c: EngineConfig) => StartDb =
    dbFactoryFromOptions ?? ((): StartDb => pgPool as unknown as StartDb);

  const compositionEnv = tryLoadAdminApiEnv(env, logger);
  const giteaClientFactory =
    options.giteaClientFactory ??
    ((baseUrl: string): GiteaClient => createGiteaClient({ baseUrl }));

  // Pick the serverFactory:
  //   - test-supplied override → use it,
  //   - production wiring (env complete + pool present) →
  //     productionServerFactory,
  //   - otherwise → staticUiOnlyServerFactory (boot-tolerant).
  const userServerFactory = options.serverFactory;
  const serverFactory = (
    probes: ProbeMap,
  ): Promise<StartServer> | StartServer => {
    if (userServerFactory !== undefined) {
      return userServerFactory(probes, config, logger);
    }
    if (compositionEnv !== null && pgPool !== null) {
      // Build the credential store the binding-create handler
      // uses — DrizzleCredentialStore wraps the same pg pool +
      // ENCRYPTION_KEY the rest of the engine consumes.
      let credentialStore: import("@opencoo/shared/credential-store").CredentialStore | null = null;
      try {
        credentialStore = new DrizzleCredentialStore({
          db: drizzle(pgPool) as unknown as ConstructorParameters<
            typeof DrizzleCredentialStore
          >[0]["db"],
          key: loadEncryptionKey(env as NodeJS.ProcessEnv),
          logger,
        });
      } catch (err) {
        logger.warn("admin_api.binding_create_disabled", {
          reason:
            "ENCRYPTION_KEY missing or invalid — POST /api/admin/source-bindings will surface 500",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Phase-a appendix #4 PR-B (C2) — create a read-only BullMQ Queue
      // handle for the ingestion-scanner queue so GET /api/admin/pipelines
      // returns live stats. We use the same REDIS_URL the engine scaffold
      // opens for its ioredis connection. `buildEngineQueue` validates the
      // slug and names it `ingestion.scanner`.
      //
      // Design choice: engine-self-operating opens its own queue handle
      // (read-only probe) rather than writing pipeline stats to a Postgres
      // table. This avoids a new table + polling overhead and keeps the stats
      // fresh with zero write-path coupling. Under 80 lines total.
      let ingestionQueue: Parameters<typeof productionServerFactory>[0]["ingestionQueue"] | undefined;
      try {
        // Cast: BullMQ Queue.getJobCounts takes JobType[] (a restricted literal
        // union), but our QueueRef interface uses string[] for testability.
        // The runtime values ("waiting", "failed") are valid JobType members;
        // the cast is safe.
        ingestionQueue = buildEngineQueue("ingestion", "scanner", {
          connection: { url: config.redisUrl, maxRetriesPerRequest: null, enableReadyCheck: false },
        }) as unknown as Parameters<typeof productionServerFactory>[0]["ingestionQueue"];
      } catch (err) {
        logger.warn("admin_api.pipelines_queue_disabled", {
          reason: "Failed to construct ingestion.scanner queue handle — GET /api/admin/pipelines will return zeroed stats",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return productionServerFactory({
        probes,
        config,
        logger,
        pgPool,
        giteaClient: giteaClientFactory(compositionEnv.giteaBaseUrl),
        compositionEnv,
        ...(credentialStore !== null ? { credentialStore } : {}),
        ...(ingestionQueue !== undefined ? { ingestionQueue } : {}),
      });
    }
    return staticUiOnlyServerFactory(probes, config, logger);
  };

  const baseOptions: BaseStartOptions<EngineConfig, SelfOperatingRegistry> = {
    config,
    dbFactory,
    redisFactory: options.redisFactory ?? defaultRedisFactory,
    serverFactory,
    ...(options.registry !== undefined ? { registry: options.registry } : {}),
    ...(options.probeExtender !== undefined
      ? { probeExtender: options.probeExtender }
      : {}),
  };
  return startEngine<EngineConfig, SelfOperatingRegistry>(baseOptions);
}

// Re-export the default factories for tests that want to
// reference them by identity.
export { defaultDbFactory, defaultRedisFactory, staticUiOnlyServerFactory };

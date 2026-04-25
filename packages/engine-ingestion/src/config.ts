/**
 * Engine-ingestion-specific config loader. The base shape lives
 * in `@opencoo/shared/engine-scaffold`; this module extends it
 * with `giteaUrl` (only ingestion writes to the wiki) and wires
 * the engine-named errors via `requireWithFile` / `parseEnginePort`.
 */
import { z } from "zod";

import {
  BaseEngineConfigSchema,
  parseEngineConfig,
  parseEnginePort,
  requireWithFile,
} from "@opencoo/shared/engine-scaffold";

const ENGINE_NAME = "ingestion" as const;

const IngestionConfigSchema = BaseEngineConfigSchema.extend({
  giteaUrl: z.string().url(),
});

export type EngineConfig = z.infer<typeof IngestionConfigSchema>;

/**
 * Parse + validate engine-ingestion config. Pure function — pass
 * `process.env` (or a stub for tests). Throws on missing required
 * vars or schema violations.
 */
export function loadEngineConfig(
  env: Record<string, string | undefined>,
): EngineConfig {
  const databaseUrl = requireWithFile(env, "DATABASE_URL", ENGINE_NAME);
  const redisUrl = requireWithFile(env, "REDIS_URL", ENGINE_NAME);
  const giteaUrl = requireWithFile(env, "GITEA_URL", ENGINE_NAME);
  const port = parseEnginePort(env, ENGINE_NAME);

  return parseEngineConfig({
    engineName: ENGINE_NAME,
    fields: {
      databaseUrl,
      redisUrl,
      giteaUrl,
      port,
      logLevel: env["LOG_LEVEL"],
      nodeEnv: env["NODE_ENV"],
    },
    schema: IngestionConfigSchema,
  });
}

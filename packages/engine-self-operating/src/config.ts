/**
 * Engine-self-operating config loader. Extends the shared
 * `BaseEngineConfigSchema` with the self-operating-specific
 * `uiDistPath` (the directory containing the bundled Management
 * UI SPA — typically a `dist/` checked out next to the engine
 * package in production deploys).
 *
 * `UI_DIST_PATH` is allow-listed in the no-feature-env-vars
 * ESLint rule (PR 18 / plan #82 step 2). The `_FILE` variant
 * follows the same Docker-secrets convention every other URL-
 * style var here uses — useful when the SPA dist path is mounted
 * via tmpfs and the inline form is the dev fallback.
 */
import { z } from "zod";

import {
  BaseEngineConfigSchema,
  parseEngineConfig,
  parseEnginePort,
  readWithFile,
  requireWithFile,
} from "@opencoo/shared/engine-scaffold";

const ENGINE_NAME = "self-operating" as const;

const SelfOperatingConfigSchema = BaseEngineConfigSchema.extend({
  /** Absolute path to the bundled Management UI dist/ directory.
   *  Optional — when absent, the SPA fallback returns 503 (see
   *  Q10: boot-tolerant). */
  uiDistPath: z.string().min(1).optional(),
});

export type EngineConfig = z.infer<typeof SelfOperatingConfigSchema>;

/**
 * Parse + validate engine-self-operating config. Pure function —
 * pass `process.env` (or a stub for tests). Throws on missing
 * required vars or schema violations. `UI_DIST_PATH` is OPTIONAL
 * by design (Q10): a misconfigured deploy that forgets to mount
 * the SPA still boots; the SPA fallback returns 503 with a clear
 * "ui dist path not configured" reason for the operator log.
 */
export function loadEngineConfig(
  env: Record<string, string | undefined>,
): EngineConfig {
  const databaseUrl = requireWithFile(env, "DATABASE_URL", ENGINE_NAME);
  const redisUrl = requireWithFile(env, "REDIS_URL", ENGINE_NAME);
  const uiDistPath = readWithFile(env, "UI_DIST_PATH");
  const port = parseEnginePort(env, ENGINE_NAME);

  return parseEngineConfig({
    engineName: ENGINE_NAME,
    fields: {
      databaseUrl,
      redisUrl,
      ...(uiDistPath !== undefined ? { uiDistPath } : {}),
      port,
      logLevel: env["LOG_LEVEL"],
      nodeEnv: env["NODE_ENV"],
    },
    schema: SelfOperatingConfigSchema,
  });
}

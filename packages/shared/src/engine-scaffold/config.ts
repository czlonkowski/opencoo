/**
 * Boot-time engine configuration loader (engine-agnostic).
 *
 * The shared layer owns the BASE config shape every opencoo engine
 * needs: `databaseUrl`, `redisUrl`, `port`, `logLevel`, `nodeEnv`.
 * Engine-specific extensions (`giteaUrl` for ingestion;
 * `uiDistPath` for self-operating) are layered on top by the
 * consuming package via Zod schema extension.
 *
 * The `_FILE` Docker-secrets convention is honoured by every
 * `*_URL` style var — `<NAME>_FILE` WINS when both are set
 * (matches the .env.example pattern + `loadEncryptionKey` from
 * `@opencoo/shared/credential-store`). Setting both is a misconfig,
 * but production secrets are typically file-mounted via tmpfs and
 * the inline var is the development fallback — honouring the file
 * is the safe answer.
 *
 * Validation is Zod-based; missing required vars and malformed
 * values throw at boot. Callers (composition root or CLI) catch
 * the throw and exit non-zero — the loader itself never calls
 * process.exit.
 */
import fs from "node:fs";
import { z } from "zod";

export const EngineLogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export const EngineNodeEnvSchema = z
  .enum(["development", "test", "staging", "production"])
  .default("development");

/** Base config fields every opencoo engine needs. Consumer
 *  packages extend this schema with engine-specific fields
 *  (`giteaUrl`, `uiDistPath`, etc.) before calling
 *  `parseEngineConfig`. */
export const BaseEngineConfigSchema = z.object({
  databaseUrl: z.string().min(1),
  redisUrl: z.string().min(1),
  port: z.number().int().positive().max(65535).default(8080),
  logLevel: EngineLogLevelSchema.default("info"),
  nodeEnv: EngineNodeEnvSchema,
});

export type BaseEngineConfig = z.infer<typeof BaseEngineConfigSchema>;

/**
 * Read a value with the repo-wide `<NAME>` / `<NAME>_FILE`
 * precedence (Docker-secrets convention): the `_FILE` variant
 * WINS when both are set. Reads the file at `_FILE` and strips
 * a single trailing newline run. Falls through to the inline
 * env var when `_FILE` is unset/empty. Returns `undefined` when
 * neither is set.
 */
export function readWithFile(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const filePath = env[`${name}_FILE`];
  if (typeof filePath === "string" && filePath.length > 0) {
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.replace(/\r?\n+$/, "");
  }
  const inline = env[name];
  if (typeof inline === "string" && inline.length > 0) {
    return inline;
  }
  return undefined;
}

/**
 * Required-variant of `readWithFile`. Throws a uniform "missing
 * var" error message naming both the inline and `_FILE` env-var
 * names so misconfigured deploys see exactly which knob to set.
 *
 * `engineName` is woven into the error message so multi-engine
 * deployments can pinpoint which engine's config failed.
 */
export function requireWithFile(
  env: Record<string, string | undefined>,
  name: string,
  engineName: string,
): string {
  const value = readWithFile(env, name);
  if (value === undefined) {
    throw new Error(
      `engine-${engineName} config: ${name} (or ${name}_FILE) is required`,
    );
  }
  return value;
}

export interface ParseEngineConfigOptions<TConfig> {
  readonly engineName: string;
  /** Pre-built fields the consumer has already gathered (typically
   *  databaseUrl/redisUrl read via `requireWithFile`, plus any
   *  engine-specific fields the consumer's schema requires). The
   *  generic call here re-validates the whole shape via the
   *  consumer's `schema`. */
  readonly fields: unknown;
  readonly schema: z.ZodType<TConfig>;
}

/**
 * Parse a fully-gathered config object through the consumer's Zod
 * schema. Each engine's `loadEngineConfig` reads env vars (with
 * the `_FILE` precedence) and assembles a candidate object,
 * then calls this helper to get the strongly-typed result. The
 * unknown-typed `fields` parameter forces the consumer to think
 * about its inputs — no `any` casts at the call site (planner
 * Q1 escalation).
 */
export function parseEngineConfig<TConfig>(
  options: ParseEngineConfigOptions<TConfig>,
): TConfig {
  return options.schema.parse(options.fields);
}

/**
 * PORT parsing with engine-named error. Returns the default
 * (8080) when the env var is absent; throws a clear message
 * when present but malformed.
 */
export function parseEnginePort(
  env: Record<string, string | undefined>,
  engineName: string,
  defaultPort = 8080,
): number {
  const portRaw = env["PORT"];
  if (portRaw === undefined) return defaultPort;
  const port = Number(portRaw);
  if (!Number.isFinite(port) || !Number.isInteger(port) || port <= 0) {
    throw new Error(
      `engine-${engineName} config: PORT must be a positive integer, got ${JSON.stringify(portRaw)}`,
    );
  }
  return port;
}

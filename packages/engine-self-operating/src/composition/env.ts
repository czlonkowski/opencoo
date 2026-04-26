/**
 * Production composition env loader (PR 30 / plan #135).
 *
 * Resolves the admin-API + production-wiring env vars added in
 * PR 28 + PR 29 + PR 30. Mirrors the `_FILE` Docker-secrets
 * convention every other URL/secret in opencoo uses (the file
 * variant WINS when both are set).
 *
 * The loader fails LOUD on missing required vars — production
 * boot stops here rather than starting a half-wired engine.
 * `loadEngineConfig` from `config.ts` already validates the
 * scaffold-level vars (DATABASE_URL, REDIS_URL, PORT, …); this
 * loader handles the admin-API additions.
 */
import {
  readWithFile,
  requireWithFile,
} from "@opencoo/shared/engine-scaffold";

const COMPOSITION_NAME = "self-operating-composition" as const;

export interface AdminApiCompositionEnv {
  /** Gitea team slug for admin authz (PR 28). Required for the
   *  admin API to function — the verifyAdmin preHandler matches
   *  this against the user's `gitea_teams`. */
  readonly adminTeamSlug: string;
  /** HMAC key for the sovereignty-diff token (PR 28). Required.
   *  Treated as bytes, not a string — the file variant is the
   *  recommended deploy path. */
  readonly sessionHmacKey: Buffer;
  /** Gitea base URL for `whoami` calls (PR 28). Required. */
  readonly giteaBaseUrl: string;
  /** Whether `LLM_DEBUG_LOG=1` is set. Drives the persistent
   *  banner the Management UI renders. v0.1 reads any non-empty
   *  value as truthy (operator wouldn't set `LLM_DEBUG_LOG=0`
   *  to opt OUT — they'd unset). */
  readonly llmDebugLog: boolean;
}

/**
 * Load the admin-API composition env. Throws on missing
 * required vars; the caller (production server-factory) catches
 * and exits non-zero.
 */
export function loadAdminApiCompositionEnv(
  env: Record<string, string | undefined>,
): AdminApiCompositionEnv {
  const adminTeamSlug = requireWithFile(env, "ADMIN_TEAM_SLUG", COMPOSITION_NAME);
  const sessionHmacKeyRaw = requireWithFile(
    env,
    "SESSION_HMAC_KEY",
    COMPOSITION_NAME,
  );
  const giteaBaseUrl = requireWithFile(
    env,
    "GITEA_BASE_URL",
    COMPOSITION_NAME,
  );
  const llmDebugLogRaw = readWithFile(env, "LLM_DEBUG_LOG");
  const llmDebugLog =
    typeof llmDebugLogRaw === "string" && llmDebugLogRaw.length > 0;

  return {
    adminTeamSlug,
    // The HMAC key is binary by construction — a 32-byte random
    // value base64-encoded in the env or file. We pass the bytes
    // through verbatim; the verifier doesn't care about encoding
    // as long as it's consistent.
    sessionHmacKey: Buffer.from(sessionHmacKeyRaw, "utf8"),
    giteaBaseUrl,
    llmDebugLog,
  };
}

/**
 * Production composition env loader (PR 30 / plan #135).
 *
 * Resolves the admin-API + production-wiring env vars added in
 * PR 28 + PR 29 + PR 30. Mirrors the `_FILE` Docker-secrets
 * convention every other URL/secret in opencoo uses (the file
 * variant WINS when both are set).
 *
 * The loader THROWS on missing required vars or invalid shapes
 * (e.g. SESSION_HMAC_KEY not a valid base64 32-byte). Boot
 * tolerance lives one level up: `start.ts` catches and falls
 * back to `staticUiOnlyServerFactory` so the engine boots with
 * admin-API DISABLED rather than half-wired. `loadEngineConfig`
 * from `config.ts` already validates the scaffold-level vars
 * (DATABASE_URL, REDIS_URL, PORT, …); this loader handles the
 * admin-API additions only.
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
   *  Provisioned as `crypto.randomBytes(32).toString("base64")`
   *  by `opencoo setup`; the loader base64-DECODES + validates
   *  length === 32. The Buffer carries the raw 32 bytes the
   *  sovereignty-token primitives expect. */
  readonly sessionHmacKey: Buffer;
  /** Gitea base URL for `whoami` calls (PR 28). Required. */
  readonly giteaBaseUrl: string;
  /** Whether `LLM_DEBUG_LOG=1` is set. Drives the persistent
   *  banner the Management UI renders. v0.1 reads any non-empty
   *  value as truthy (operator wouldn't set `LLM_DEBUG_LOG=0`
   *  to opt OUT — they'd unset). */
  readonly llmDebugLog: boolean;
  /** Phase-a appendix #2 — Gitea organisation that owns repos
   *  provisioned by `POST /api/admin/domains`. Optional;
   *  defaults to 'opencoo'. The `_FILE` Docker-secrets
   *  convention applies. */
  readonly giteaProvisionOrg: string;
  /** Phase-a appendix #12 PR-Z8 (G10) — gitea-wiki-mcp-server
   *  base URL (e.g. `http://gitea-wiki-mcp:3000`). When set
   *  alongside `MCP_BEARER_TOKEN`, the domain-create handler
   *  POSTs `/refresh-all` so the MCP server's in-memory REPOS
   *  list picks up the new repo without operator hand-edit.
   *  Optional — left undefined means "no MCP server in this
   *  deployment, skip the ping". */
  readonly giteaWikiMcpUrl: string | undefined;
  /** Phase-a appendix #12 PR-Z8 (G10) — bearer token the
   *  /refresh-all dispatcher carries. Must match the MCP
   *  server's `MCP_BEARER_TOKEN`. Read with the standard
   *  `_FILE` precedence. Undefined → skip the ping. */
  readonly mcpBearerToken: string | undefined;
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

  // GITEA_PROVISION_ORG is optional with a default — the
  // existing `_FILE` Docker-secrets convention applies. v0.1
  // ships the default 'opencoo' so a fresh `pnpm opencoo`
  // works against the local-dev compose stack without any env
  // wiring.
  const provisionOrgRaw = readWithFile(env, "GITEA_PROVISION_ORG");
  const giteaProvisionOrg =
    typeof provisionOrgRaw === "string" && provisionOrgRaw.length > 0
      ? provisionOrgRaw
      : "opencoo";

  // SESSION_HMAC_KEY is provisioned by `opencoo setup` as a
  // 32-byte random value base64-encoded (44 chars including
  // padding). Decode + length-validate here so a deployment
  // that fat-fingers the value (truncated paste, wrong format)
  // fails LOUD at boot rather than silently using the base64
  // text bytes as the HMAC key (which would invalidate every
  // sovereignty-token issued under a different deploy that
  // expected the decoded shape).
  let sessionHmacKey: Buffer;
  try {
    sessionHmacKey = Buffer.from(sessionHmacKeyRaw, "base64");
  } catch (err) {
    throw new Error(
      `${COMPOSITION_NAME}: SESSION_HMAC_KEY is not valid base64 (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (sessionHmacKey.length !== 32) {
    throw new Error(
      `${COMPOSITION_NAME}: SESSION_HMAC_KEY decoded to ${sessionHmacKey.length} bytes; expected 32 (base64-encoded crypto.randomBytes(32))`,
    );
  }

  // Phase-a appendix #12 PR-Z8 (G10) — /refresh-all ping config.
  // Both vars are OPTIONAL: when either is unset the domain-create
  // handler skips the ping. Partial config (URL but no bearer, or
  // bearer but no URL) is also treated as "skip" — partial would
  // either 401 or DNS-fail, and the helper swallows both, but
  // skipping is cleaner.
  const giteaWikiMcpUrl = readWithFile(env, "GITEA_WIKI_MCP_URL");
  const mcpBearerToken = readWithFile(env, "MCP_BEARER_TOKEN");

  return {
    adminTeamSlug,
    sessionHmacKey,
    giteaBaseUrl,
    llmDebugLog,
    giteaProvisionOrg,
    giteaWikiMcpUrl,
    mcpBearerToken,
  };
}

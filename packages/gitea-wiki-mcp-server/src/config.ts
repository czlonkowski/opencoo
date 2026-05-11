/**
 * Configuration loading and validation. All env parsing happens here once at
 * startup — downstream code should import `loadConfig()` output, never read
 * `process.env` directly.
 *
 * The `_FILE` Docker-secrets convention is honoured for every secret-bearing
 * variable (`MCP_BEARER_TOKEN`, `GITEA_PAT`, `GITEA_WEBHOOK_SECRET`,
 * `GITEA_OAUTH_CLIENT_SECRET`, `GITEA_ADMIN_TOKEN`): `<NAME>_FILE` WINS when
 * both are set; the file is read once at boot, trailing newline runs stripped.
 * Mirrors the same shape `readWithFile` exposes in
 * `@opencoo/shared/engine-scaffold` so partner deployments use one secrets
 * pattern everywhere (closes G9 — phase-a appendix #12 PR-Z8).
 */
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";

dotenv.config();

/**
 * Read a value with the repo-wide `<NAME>` / `<NAME>_FILE` precedence
 * (Docker-secrets convention): the `_FILE` variant WINS when both are set.
 * Reads the file at `_FILE`, strips a single trailing newline run, and
 * returns the contents. Falls through to the inline env var when `_FILE`
 * is unset/empty. Returns `undefined` when neither is set.
 *
 * Synchronous on purpose — boot-time only, runs ONCE per process, and the
 * rest of `loadConfig()` is already synchronous. Keeping it sync means
 * callers don't need to thread async/await through the config loader.
 *
 * Throws if `<NAME>_FILE` is set but the file is missing or unreadable —
 * a typo in a Docker-secret mount is a misconfiguration the operator
 * needs to see LOUD at boot, not silently fall through to the inline
 * (possibly stale) variant. The thrown error names BOTH the env var
 * (`<NAME>_FILE`) and the path that failed, so the operator can fix
 * the typo without grepping through stack traces — Copilot triage
 * (PR-Z8 follow-up) called out that a bare `ENOENT` was useless.
 */
export function readWithFile(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const filePath = env[`${name}_FILE`];
  if (typeof filePath === "string" && filePath.length > 0) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return raw.replace(/\r?\n+$/, "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to read ${name}_FILE at ${filePath}: ${msg}`,
      );
    }
  }
  const inline = env[name];
  if (typeof inline === "string" && inline.length > 0) {
    return inline;
  }
  return undefined;
}

const RepoEntrySchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-_]*$/, "slug must be lowercase alphanumeric with - or _"),
    owner: z.string().min(1),
    name: z.string().min(1),
    default: z.boolean().optional().default(false),
    access_tag: z.string().optional(),
    // `aggregator: true` marks ONE repo as the source for the reserved
    // `worldview://company` MCP resource (company.md at repo root).
    // At most one entry may set this; the `validateRepos` refinement
    // enforces it.
    aggregator: z.boolean().optional().default(false),
  })
  .strict();

export type RepoEntry = z.infer<typeof RepoEntrySchema>;

// Slug reserved for the aggregator's `worldview://company` URI. Config
// that binds a real repo to this slug would create an ambiguous
// routing rule; reject at boot.
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(["company"]);

/**
 * Exit-free validator for the REPOS array. Throws on violations so
 * callers (loadConfig + tests) can translate to user-friendly error
 * messages without coupling to process.exit.
 */
export function validateRepos(repos: ReadonlyArray<unknown>): RepoEntry[] {
  const parsed = z.array(RepoEntrySchema).parse(repos);
  const aggregators = parsed.filter((r) => r.aggregator);
  if (aggregators.length > 1) {
    throw new Error(
      `REPOS may declare at most one aggregator; found ${aggregators.length}: ${aggregators
        .map((r) => r.slug)
        .join(", ")}`,
    );
  }
  for (const r of parsed) {
    if (RESERVED_SLUGS.has(r.slug)) {
      throw new Error(
        `REPOS slug "${r.slug}" is reserved (reserved slugs: ${[...RESERVED_SLUGS].join(", ")})`,
      );
    }
  }
  return parsed;
}

const ConfigSchema = z
  .object({
    mcpMode: z.enum(["stdio", "http"]).default("stdio"),
    port: z.coerce.number().int().min(1).max(65535).default(3000),
    host: z.string().default("0.0.0.0"),
    bearerToken: z.string().min(16, "MCP_BEARER_TOKEN must be at least 16 chars"),
    giteaPat: z.string().min(1, "GITEA_PAT is required"),
    giteaBaseUrl: z.string().url(),
    repos: z.array(RepoEntrySchema).min(1, "REPOS must list at least one repo"),
    dataDir: z.string().default("./data"),
    syncIntervalMin: z.coerce.number().int().min(0).default(5),
    giteaWebhookSecret: z.string().optional().default(""),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
    // --- OAuth 2.1 public-access path (all optional; absent → OAuth disabled) -
    // Public URL this server is reachable at — used as the OAuth issuer and in
    // the WWW-Authenticate resource_metadata hint. Leave empty for internal-only.
    publicUrl: z.string().url().optional(),
    // Publicly-reachable Gitea URL used in OAuth discovery (authorize_endpoint,
    // token_endpoint). Defaults to giteaBaseUrl when unset — required only
    // when the server talks to Gitea over an internal URL (docker network,
    // VPN) that browsers can't reach.
    giteaPublicUrl: z.string().url().optional(),
    // Gitea OAuth2 app credentials. The "shared client" the DCR proxy hands to
    // every MCP client (ChatGPT, etc.). Create this once in Gitea admin UI.
    giteaOauthClientId: z.string().optional(),
    giteaOauthClientSecret: z.string().optional(),
    // Gitea admin API token — optional. If provided, the DCR endpoint will try
    // to append newly-seen redirect_uris to the shared OAuth app. Without it,
    // the admin must pre-add every ChatGPT redirect URI manually.
    giteaAdminToken: z.string().optional(),
    // Comma-separated origin allow-list for CORS. Empty → allow all origins
    // (matches the legacy behavior for internal-only deploys).
    corsOrigins: z.string().optional().default(""),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Parse and validate env vars. Exits the process with a clear message if
 * anything required is missing — we'd rather crash at boot than serve a
 * partially-configured server.
 */
export function loadConfig(): Config {
  const reposRaw = process.env.REPOS ?? "[]";
  let reposParsed: unknown;
  try {
    reposParsed = JSON.parse(reposRaw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: REPOS env is not valid JSON — ${msg}`);
    process.exit(1);
  }

  // Secret-bearing vars honor the `<NAME>_FILE` Docker-secrets
  // precedence; non-secret config (URLs, host, port, log level)
  // stays on direct env reads. Wrap the file reads in try/catch so
  // a malformed file path surfaces with the env-var NAME the operator
  // typo'd, not a bare `ENOENT` from node.
  let bearerToken: string | undefined;
  let giteaPat: string | undefined;
  let giteaWebhookSecret: string | undefined;
  let giteaOauthClientSecret: string | undefined;
  let giteaAdminToken: string | undefined;
  try {
    bearerToken = readWithFile(process.env, "MCP_BEARER_TOKEN");
    giteaPat = readWithFile(process.env, "GITEA_PAT");
    giteaWebhookSecret = readWithFile(process.env, "GITEA_WEBHOOK_SECRET");
    giteaOauthClientSecret = readWithFile(process.env, "GITEA_OAUTH_CLIENT_SECRET");
    giteaAdminToken = readWithFile(process.env, "GITEA_ADMIN_TOKEN");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: secret file read failed — ${msg}`);
    process.exit(1);
  }

  const parsed = ConfigSchema.safeParse({
    mcpMode: process.env.MCP_MODE,
    port: process.env.PORT,
    host: process.env.HOST,
    bearerToken,
    giteaPat,
    giteaBaseUrl: process.env.GITEA_BASE_URL,
    repos: reposParsed,
    dataDir: process.env.DATA_DIR,
    syncIntervalMin: process.env.SYNC_INTERVAL_MIN,
    giteaWebhookSecret: giteaWebhookSecret ?? "",
    logLevel: process.env.LOG_LEVEL,
    publicUrl: process.env.PUBLIC_URL,
    giteaPublicUrl: process.env.GITEA_PUBLIC_URL,
    giteaOauthClientId: process.env.GITEA_OAUTH_CLIENT_ID,
    giteaOauthClientSecret,
    giteaAdminToken,
    corsOrigins: process.env.CORS_ORIGINS,
  });

  if (!parsed.success) {
    console.error("ERROR: Invalid configuration:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    console.error("\nSee .env.example for required variables.");
    process.exit(1);
  }

  // Exactly one default repo.
  const defaults = parsed.data.repos.filter((r) => r.default);
  if (defaults.length === 0) {
    console.error(
      "ERROR: REPOS must have exactly one entry with `default: true`. None found.",
    );
    process.exit(1);
  }
  if (defaults.length > 1) {
    console.error(
      `ERROR: REPOS has ${defaults.length} entries with default:true — exactly one allowed.`,
    );
    process.exit(1);
  }

  // Unique slugs.
  const slugs = new Set<string>();
  for (const r of parsed.data.repos) {
    if (slugs.has(r.slug)) {
      console.error(`ERROR: duplicate repo slug "${r.slug}" in REPOS.`);
      process.exit(1);
    }
    slugs.add(r.slug);
  }

  // Aggregator (≤1) + reserved-slug refinement. Handled by the shared
  // validator so the same rules surface in tests.
  try {
    validateRepos(parsed.data.repos);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: ${msg}`);
    process.exit(1);
  }

  // Normalize dataDir to absolute.
  const absoluteDataDir = path.resolve(parsed.data.dataDir);

  // OAuth vars are all-or-nothing: either all three (publicUrl, clientId,
  // clientSecret) are set or none are. Partial config = misconfiguration.
  const oauthPresent = [
    parsed.data.publicUrl,
    parsed.data.giteaOauthClientId,
    parsed.data.giteaOauthClientSecret,
  ].filter((v) => typeof v === "string" && v.length > 0).length;
  if (oauthPresent !== 0 && oauthPresent !== 3) {
    console.error(
      "ERROR: OAuth config is partial. Set ALL of PUBLIC_URL, GITEA_OAUTH_CLIENT_ID, GITEA_OAUTH_CLIENT_SECRET — or none.",
    );
    process.exit(1);
  }

  return { ...parsed.data, dataDir: absoluteDataDir };
}

/** True when all OAuth env vars are configured. Controls whether the server
 *  exposes the /.well-known/* + /oauth/register endpoints and accepts Gitea
 *  OAuth tokens in the bearer middleware. */
export function isOAuthEnabled(config: Config): boolean {
  return Boolean(
    config.publicUrl && config.giteaOauthClientId && config.giteaOauthClientSecret,
  );
}

/**
 * Production composition root for the CLI's `serve` verb (PR-M2,
 * phase-a appendix #5).
 *
 * Reads env once, constructs the heavy ingredients (pg.Pool,
 * Redis, GiteaClient + WikiAdapter, GuardAdapter, LlmRouter,
 * CredentialStore, source-adapter factory map), and returns the
 * `WorkerContext` engine-ingestion's `start({ mode: 'workers' })`
 * consumes. The orchestrator (serve.ts) wraps composition in a
 * try/catch — on failure, it falls back to `mode: 'probes-only'`
 * with a clear stderr line so the management UI stays up.
 *
 * # Env surface
 *
 *   - `DATABASE_URL` (required) — pg.Pool connection string.
 *   - `REDIS_URL` (required) — ioredis connection URL.
 *   - `ENCRYPTION_KEY` (required) — 32-byte base64 vault key.
 *   - `GITEA_URL` (required) — Gitea base URL for wiki transport.
 *   - `GITEA_PAT` (required) — service-account PAT for wiki commits.
 *   - `GITEA_PROVISION_ORG` (optional, default 'opencoo') —
 *     org/owner of provisioned domain repos. Same env the
 *     admin-API composition env already reads.
 *
 * No NEW env vars introduced (THREAT-MODEL §2 invariant 9).
 * `GITEA_PAT` is the same credential the gitea-wiki-mcp-server
 * already consumes; `GITEA_PROVISION_ORG` is already loaded by
 * the admin-API composition env. Wiki branch + repo-prefix +
 * instance-id are HARDCODED constants in this file (not env
 * reads) — v0.1's distributable shape is one branch per repo,
 * one wiki-prefix convention, one engine instance per process.
 * If a deployment ever needs to vary them, the value moves to
 * Postgres config (UI-managed) per the §2 invariant.
 */
import pg from "pg";
import { Redis } from "ioredis";
import type { ConnectionOptions } from "bullmq";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  composeProductionWorkerContext,
  type ProductionSourceAdapterFactory,
  type ProductionWorkerContext,
} from "@opencoo/engine-ingestion";
import {
  DrizzleCredentialStore,
  loadEncryptionKey,
} from "@opencoo/shared/credential-store";
import {
  readWithFile,
  requireWithFile,
} from "@opencoo/shared/engine-scaffold";
import {
  InMemoryQueuePauser,
  LlmRouter,
  createProvider,
  type LlmProvider,
} from "@opencoo/shared/llm-router";
import { ConsoleLogger, type Logger } from "@opencoo/shared/logger";
import { scrubPat } from "@opencoo/shared/scrub";

import {
  GiteaRestClient,
  giteaWikiAdapter,
} from "@opencoo/wiki-gitea";
import { guardRedactionRegex } from "@opencoo/guard-redaction-regex";

const COMPOSITION_NAME = "cli/serve" as const;

export interface ProductionCompositionResult {
  readonly workerContext: ProductionWorkerContext;
  readonly redisConnection: ConnectionOptions;
  readonly pgPool: pg.Pool;
  readonly redis: Redis;
}

export interface ComposeProductionArgs {
  readonly env: Record<string, string | undefined>;
  /** Optional logger override. Defaults to a ConsoleLogger writing
   *  to stdout. */
  readonly logger?: Logger;
}

/** Construct the production WorkerContext + the underlying pg.Pool
 *  / Redis handles. The orchestrator owns lifecycle of every
 *  returned handle — `closeProducers` on the WorkerContext closes
 *  the producer-side BullMQ Queue; the orchestrator separately
 *  closes the pg.Pool + Redis.
 *
 *  Throws on missing required env or any construction failure.
 *  Caller wraps in try/catch and falls back to probes-only.
 */
export async function composeProductionFromEnv(
  args: ComposeProductionArgs,
): Promise<ProductionCompositionResult> {
  const logger = args.logger ?? new ConsoleLogger();
  const databaseUrl = requireWithFile(args.env, "DATABASE_URL", COMPOSITION_NAME);
  const redisUrl = requireWithFile(args.env, "REDIS_URL", COMPOSITION_NAME);
  const giteaUrl = requireWithFile(args.env, "GITEA_URL", COMPOSITION_NAME);
  const giteaPat = requireWithFile(args.env, "GITEA_PAT", COMPOSITION_NAME);

  const provisionOrg = readWithFile(args.env, "GITEA_PROVISION_ORG") ?? "opencoo";
  // v0.1 baked-in constants — see file-header note. Per
  // THREAT-MODEL §2 invariant 9, these MUST NOT be env vars.
  const wikiBranch = "main";
  const wikiRepoPrefix = "wiki";
  const instanceId = "opencoo";

  const pgPool = new pg.Pool({ connectionString: databaseUrl });
  const redis = new Redis(redisUrl, {
    // BullMQ requirement.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  const db = drizzle(pgPool);

  // Credential store — encrypts/decrypts via AES-GCM with the
  // vault key. The vault key MUST be a 32-byte base64 string;
  // loadEncryptionKey throws on invalid shape.
  const credentialStore = new DrizzleCredentialStore({
    db: db as unknown as ConstructorParameters<
      typeof DrizzleCredentialStore
    >[0]["db"],
    key: loadEncryptionKey(args.env as NodeJS.ProcessEnv),
    logger,
  });

  // WikiAdapter — production Gitea REST client wrapped in the
  // shared adapter shape.
  const giteaClient = new GiteaRestClient({
    url: giteaUrl,
    token: giteaPat,
  });
  const wikiAdapter = giteaWikiAdapter({
    client: giteaClient,
    owner: provisionOrg,
    repoPrefix: wikiRepoPrefix,
    branch: wikiBranch,
  });

  // GuardAdapter — single regex-redaction baseline; per-domain
  // policy upgrades arrive in v0.2.
  const guardAdapter = guardRedactionRegex();

  // LlmRouter — production wiring requires a real LlmProvider.
  // For v0.1 the provider needs ONE concrete implementation per
  // deployment; the per-domain `llm_policy` selects between
  // providers via the `LlmProviderCall.provider` field. This
  // factory composes a multi-provider dispatcher that lazy-loads
  // the matching `@ai-sdk/*` package on the first call. When NO
  // provider env is set, the dispatcher throws on every call —
  // workers that don't reach an LLM call (e.g. the index-rebuild
  // pipeline against an empty wiki) still function.
  const router = new LlmRouter({
    db: db as unknown as ConstructorParameters<typeof LlmRouter>[0]["db"],
    env: args.env as NodeJS.ProcessEnv,
    logger,
    pauser: new InMemoryQueuePauser(),
    provider: createMultiProviderDispatcher(args.env, logger),
  });

  // Source-adapter factories — the orchestrator dynamic-imports
  // every shipped adapter package. The shared adapter-registry
  // contract gives us the slug union; we wire one factory per
  // slug, each adapting that adapter's specific extras shape into
  // the production-context's narrower `(credentialStore,
  // credentialId, config)` signature.
  const sourceAdapterFactories = await loadSourceAdapterFactories(logger);

  const workerContext = await composeProductionWorkerContext({
    db: db as unknown as Parameters<
      typeof composeProductionWorkerContext
    >[0]["db"],
    logger,
    redisConnection: {
      url: redisUrl,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    },
    redisClient: redis,
    credentialStore,
    sourceAdapterFactories,
    wikiAdapter,
    router,
    guardAdapter,
    author: {
      name: `opencoo-${instanceId}`,
      email: `${instanceId}@opencoo.local`,
    },
    instanceId,
  });

  return {
    workerContext,
    redisConnection: {
      url: redisUrl,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    },
    pgPool,
    redis,
  };
}

/** Multi-provider dispatcher — routes every `LlmProviderCall` to
 *  the matching `@ai-sdk/*` provider via the shared
 *  `createProvider` factory. Caches per-provider client modules
 *  to avoid re-importing on every call.
 *
 *  Provider-specific API keys come from env (already standard
 *  practice; not new): `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
 *  `GOOGLE_API_KEY`, `OLLAMA_BASE_URL`. Missing key → the
 *  underlying provider's `LlmProviderError` surfaces on the
 *  first call for that provider; the per-pipeline retry policy
 *  bubbles it. */
function createMultiProviderDispatcher(
  env: Record<string, string | undefined>,
  logger: Logger,
): LlmProvider {
  // Lazy-load each provider on first use — keeps boot fast and
  // makes the dispatcher tolerant of missing optional deps.
  const cache = new Map<string, Promise<LlmProvider>>();
  const resolve = (providerName: string): Promise<LlmProvider> => {
    let cached = cache.get(providerName);
    if (cached !== undefined) return cached;
    cached = (async (): Promise<LlmProvider> => {
      // Provider-specific opts. Centralised so a future env-var
      // rename doesn't require touching this dispatcher.
      const opts: { apiKey?: string; baseUrl?: string } = {};
      if (providerName === "openai") {
        const k = env["OPENAI_API_KEY"];
        if (k !== undefined && k.length > 0) opts.apiKey = k;
      } else if (providerName === "anthropic") {
        const k = env["ANTHROPIC_API_KEY"];
        if (k !== undefined && k.length > 0) opts.apiKey = k;
      } else if (providerName === "google") {
        const k = env["GOOGLE_API_KEY"];
        if (k !== undefined && k.length > 0) opts.apiKey = k;
      } else if (providerName === "ollama") {
        const k = env["OLLAMA_BASE_URL"];
        if (k !== undefined && k.length > 0) opts.baseUrl = k;
      }
      return createProvider(providerName as never, opts);
    })().catch((err: unknown) => {
      // Don't cache the rejection — let the next call retry the
      // import in case the operator fixes the env mid-run.
      cache.delete(providerName);
      logger.warn("llm_router.provider_unavailable", {
        provider: providerName,
        error: err instanceof Error ? scrubPat(err.message) : String(err),
      });
      throw err;
    });
    cache.set(providerName, cached);
    return cached;
  };

  return {
    async generate(call) {
      const provider = await resolve(call.provider);
      return provider.generate(call);
    },
  };
}

/** Dynamic-import every shipped SourceAdapter package and adapt
 *  its factory signature to the production-context narrower shape. */
async function loadSourceAdapterFactories(
  logger: Logger,
): Promise<Readonly<Record<string, ProductionSourceAdapterFactory>>> {
  const out: Partial<Record<string, ProductionSourceAdapterFactory>> = {};
  // Each block is a try-import — a missing optional adapter
  // package logs + skips rather than crashing composition.
  try {
    const mod = await import("@opencoo/source-asana");
    out["asana"] = (a: Parameters<ProductionSourceAdapterFactory>[0]) =>
      mod.createAsanaSourceAdapter({
        credentialStore: a.credentialStore,
        credentialId: a.credentialId,
        config: a.config,
      });
  } catch (err) {
    logger.warn("source_adapter_factory.skipped", {
      adapter_slug: "asana",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    const mod = await import("@opencoo/source-fireflies");
    out["fireflies"] = (a: Parameters<ProductionSourceAdapterFactory>[0]) =>
      mod.createFirefliesSourceAdapter({
        credentialStore: a.credentialStore,
        credentialId: a.credentialId,
        config: a.config,
      });
  } catch (err) {
    logger.warn("source_adapter_factory.skipped", {
      adapter_slug: "fireflies",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    const mod = await import("@opencoo/source-webhook");
    out["webhook"] = (a: Parameters<ProductionSourceAdapterFactory>[0]) =>
      mod.createSourceWebhookAdapter({
        credentialStore: a.credentialStore,
        credentialId: a.credentialId,
        config: a.config,
      });
  } catch (err) {
    logger.warn("source_adapter_factory.skipped", {
      adapter_slug: "webhook",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // Drive + n8n require production-only client constructors
  // (`makeDrive`, `makeApi`); the CLI bin.ts holds the contract
  // that v0.1 throws on these. The composition reads the same
  // env-gated shape — when env is missing the factory throws
  // with the "production client not wired" message rather than
  // silently returning a stub.
  try {
    const mod = await import("@opencoo/source-drive");
    out["drive"] = (a: Parameters<ProductionSourceAdapterFactory>[0]) =>
      mod.createGoogleDriveAdapter({
        credentialStore: a.credentialStore,
        credentialId: a.credentialId,
        config: a.config,
        makeDrive: () => {
          throw new Error(
            "drive: production makeDrive not wired in v0.1 — bind via UI when adapter ships",
          );
        },
      });
  } catch (err) {
    logger.warn("source_adapter_factory.skipped", {
      adapter_slug: "drive",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    const mod = await import("@opencoo/source-n8n");
    out["n8n"] = (a: Parameters<ProductionSourceAdapterFactory>[0]) =>
      mod.createN8nSourceAdapter({
        credentialStore: a.credentialStore,
        credentialId: a.credentialId,
        config: a.config,
        makeApi: () => {
          throw new Error(
            "n8n: production makeApi not wired in v0.1 — bind via UI when adapter ships",
          );
        },
      });
  } catch (err) {
    logger.warn("source_adapter_factory.skipped", {
      adapter_slug: "n8n",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return out as Readonly<Record<string, ProductionSourceAdapterFactory>>;
}

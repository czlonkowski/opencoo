// Lazy provider module for Azure OpenAI, authenticated via Entra ID.
//
// This resource is driven through the OpenAI-compatible `/openai/v1`
// surface (model name in the request body), NOT the classic
// `/openai/deployments/{name}/...` path — so we reuse
// `@ai-sdk/openai-compatible` exactly like the OpenRouter provider and
// point `baseURL` at `https://<resource>.openai.azure.com/openai/v1`.
//
// Auth: a Microsoft Entra service principal (client-credentials grant)
// mints a bearer token for scope
// `https://cognitiveservices.azure.com/.default`, injected per request
// via a custom `fetch`. We deliberately implement the token grant with
// a plain `fetch` rather than pulling `@azure/identity` — the
// client-credentials flow is a single token POST, and keeping the
// supply-chain surface minimal is a load-bearing project value
// (architecture §12.1). A static `api-key` fallback is supported for
// non-Entra deployments.
//
// Lives alongside the other providers so the
// `opencoo/no-direct-llm-sdk` ESLint allowlist
// (packages/shared/src/llm-router/providers/**) covers the
// `@ai-sdk/*` import.

import { generateText as aiGenerateText } from "ai";

import { LlmProviderError, LlmProviderTransientError } from "../errors.js";
import type {
  LlmProvider,
  LlmProviderCall,
  LlmProviderResponse,
} from "../interface.js";
import { isRetryableProviderError } from "../structured-output.js";

const DEFAULT_SCOPE = "https://cognitiveservices.azure.com/.default";
const DEFAULT_AUTHORITY = "https://login.microsoftonline.com";
// Refresh a little before the real expiry so an in-flight call never
// races a 401 on a just-expired token.
const EXPIRY_SAFETY_MS = 60_000;

export interface EntraTokenSourceOptions {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scope?: string;
  readonly authorityHost?: string;
  // Injectable for tests; defaults to the global fetch / clock.
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

// Returns an async getter that mints (and caches) an Entra access
// token via the OAuth2 client-credentials grant. Exported for unit
// testing the cache/refresh semantics without a live tenant.
export function createEntraTokenSource(
  opts: EntraTokenSourceOptions,
): () => Promise<string> {
  const scope = opts.scope ?? DEFAULT_SCOPE;
  const authority = opts.authorityHost ?? DEFAULT_AUTHORITY;
  const url = `${authority}/${opts.tenantId}/oauth2/v2.0/token`;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? ((): number => Date.now());

  let cached: CachedToken | null = null;

  return async (): Promise<string> => {
    if (cached !== null && cached.expiresAtMs - EXPIRY_SAFETY_MS > now()) {
      return cached.token;
    }
    const body = new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      grant_type: "client_credentials",
      scope,
    });
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw Object.assign(
        new Error(
          `Entra token request failed: ${res.status} ${detail.slice(0, 200)}`,
        ),
        { statusCode: res.status },
      );
    }
    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (json.access_token === undefined || json.access_token.length === 0) {
      throw new Error("Entra token response missing access_token");
    }
    cached = {
      token: json.access_token,
      expiresAtMs: now() + (json.expires_in ?? 3600) * 1000,
    };
    return cached.token;
  };
}

export interface AzureEntraProviderOptions {
  // e.g. https://<resource>.openai.azure.com/openai/v1
  readonly baseUrl?: string;
  readonly tenantId?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly scope?: string;
  readonly authorityHost?: string;
  // Static-key fallback (sent as the `api-key` header) for non-Entra
  // deployments. Entra creds take precedence when both are present.
  readonly apiKey?: string;
}

function hasText(v: string | undefined): v is string {
  return v !== undefined && v.length > 0;
}

export async function createAzureEntraProvider(
  opts: AzureEntraProviderOptions,
): Promise<LlmProvider> {
  let mod: typeof import("@ai-sdk/openai-compatible");
  try {
    mod = await import("@ai-sdk/openai-compatible");
  } catch (err) {
    throw new LlmProviderError(
      "Install `@ai-sdk/openai-compatible` to use the Azure provider",
      { cause: err },
    );
  }

  if (!hasText(opts.baseUrl)) {
    throw new LlmProviderError(
      "Azure provider requires baseUrl (set AZURE_OPENAI_BASE_URL, e.g. https://<resource>.openai.azure.com/openai/v1)",
    );
  }
  const baseUrl = opts.baseUrl;

  let tokenSource: (() => Promise<string>) | null = null;
  if (
    hasText(opts.tenantId) &&
    hasText(opts.clientId) &&
    hasText(opts.clientSecret)
  ) {
    tokenSource = createEntraTokenSource({
      tenantId: opts.tenantId,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      ...(hasText(opts.scope) ? { scope: opts.scope } : {}),
      ...(hasText(opts.authorityHost)
        ? { authorityHost: opts.authorityHost }
        : {}),
    });
  }

  const staticKey = opts.apiKey;
  if (tokenSource === null && !hasText(staticKey)) {
    throw new LlmProviderError(
      "Azure provider requires Entra credentials (AZURE_ENTRA_TENANT_ID, AZURE_ENTRA_CLIENT_ID, AZURE_ENTRA_CLIENT_SECRET) or AZURE_OPENAI_API_KEY",
    );
  }

  const authFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (tokenSource !== null) {
      headers.set("authorization", `Bearer ${await tokenSource()}`);
      headers.delete("api-key");
    } else if (hasText(staticKey)) {
      headers.set("api-key", staticKey);
      headers.delete("authorization");
    }
    return fetch(input, { ...init, headers });
  };

  const client = mod.createOpenAICompatible({
    name: "azure",
    baseURL: baseUrl,
    // Placeholder — authFetch overwrites the auth header per request.
    apiKey: "entra",
    fetch: authFetch,
  });

  return {
    async generate(call: LlmProviderCall): Promise<LlmProviderResponse> {
      try {
        const result = await aiGenerateText({
          model: client(call.model),
          prompt: call.prompt,
        });
        return {
          text: result.text,
          tokensIn: result.usage.inputTokens ?? 0,
          tokensOut: result.usage.outputTokens ?? 0,
        };
      } catch (err) {
        if (isRetryableProviderError(err)) {
          throw new LlmProviderTransientError("Azure provider call failed", {
            cause: err,
          });
        }
        throw new LlmProviderError("Azure provider call failed", {
          cause: err,
        });
      }
    },
  };
}

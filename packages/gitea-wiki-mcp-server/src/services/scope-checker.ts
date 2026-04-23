/**
 * PAT-scope checker for worldview resource access (THREAT-MODEL §3.14).
 *
 * For every OAuth-principal request, we ask Gitea "does this token have
 * visibility into {owner}/{repo}?" by HEAD-ing the repo endpoint. 200 →
 * allowed; 404 / 401 / any other status → denied. Results are cached
 * per (token-hash, repo) for 60s by default so a single MCP session
 * hammering multiple resources doesn't N+1 the Gitea API.
 *
 * Cache invariants:
 * - Keyed on sha256(token + '|' + owner + '/' + name). We never store
 *   the raw token in the cache — a heap dump shouldn't leak
 *   credentials.
 * - Only the boolean decision is stored, never repo contents. This
 *   keeps the PR's scope narrow and prevents stale-content leaks.
 * - `invalidate(token)` walks all entries and drops those whose key
 *   prefix matches the given token's hash; used on rotation or
 *   admin-revoke.
 *
 * Failure policy: fail-closed. Any non-200, any thrown error, any
 * timeout → deny. A checker that failed open would leak access during
 * the cache window on revoke.
 */
import crypto from "node:crypto";
import { LRUCache } from "lru-cache";

const DEFAULT_TTL_MS = 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;

export interface ScopeCheckResult {
  readonly allow: boolean;
}

export interface GiteaScopeChecker {
  check(token: string, owner: string, name: string): Promise<ScopeCheckResult>;
  invalidate(token: string): void;
}

export interface ScopeCheckerOptions {
  readonly giteaBaseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

interface CacheEntry {
  readonly allow: boolean;
  /** Prefix of the cache key we split on for invalidate(token). */
  readonly tokenHash: string;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function cacheKey(tokenHash: string, owner: string, name: string): string {
  return `${tokenHash}|${owner}/${name}`;
}

export function createGiteaScopeChecker(
  options: ScopeCheckerOptions,
): GiteaScopeChecker {
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const max = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.giteaBaseUrl.replace(/\/+$/, "");
  const cache = new LRUCache<string, CacheEntry>({ ttl, max });

  async function fetchDecision(
    token: string,
    owner: string,
    name: string,
  ): Promise<boolean> {
    try {
      const response = await fetchImpl(
        `${baseUrl}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        {
          method: "GET",
          headers: {
            // Gitea PAT style — the token is a user-scoped access token,
            // not an OAuth bearer. The `token ` prefix is the documented
            // Gitea header shape and is accepted alongside `Bearer` but
            // conveys the right intent to operators reading logs.
            Authorization: `token ${token}`,
            Accept: "application/json",
          },
        },
      );
      return response.status === 200;
    } catch {
      return false;
    }
  }

  return {
    async check(token, owner, name): Promise<ScopeCheckResult> {
      const tokenHash = hashToken(token);
      const key = cacheKey(tokenHash, owner, name);
      const cached = cache.get(key);
      if (cached !== undefined) {
        return { allow: cached.allow };
      }
      const allow = await fetchDecision(token, owner, name);
      cache.set(key, { allow, tokenHash });
      return { allow };
    },

    invalidate(token): void {
      const tokenHash = hashToken(token);
      for (const key of [...cache.keys()]) {
        const entry = cache.get(key);
        if (entry !== undefined && entry.tokenHash === tokenHash) {
          cache.delete(key);
        }
      }
    },
  };
}

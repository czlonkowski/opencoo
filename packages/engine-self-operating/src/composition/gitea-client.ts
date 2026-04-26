/**
 * Production GiteaClient — vanilla `fetch` against Gitea's REST
 * API (PR 30 / plan #135, decision Q3 — no `undici` dep).
 *
 * Implements the `GiteaClient` interface from
 * `engine-self-operating/src/admin-api/auth.ts`. The contract:
 *   `whoami(pat)` → `{username, teams: string[]}`.
 *
 * Two Gitea endpoints:
 *   1. `GET /api/v1/user` (Authorization: token <pat>) →
 *      `{login, ...}` — that's the username.
 *   2. `GET /api/v1/user/teams?limit=50` →
 *      `[{name, organization, ...}, ...]` — every team the user
 *      belongs to. We map to `<org>/<team>` slug pairs and
 *      include both forms (`<org>/<team>` AND `<team>`) so the
 *      operator can reference teams by either form in
 *      `ADMIN_TEAM_SLUG`.
 *
 * # Security pins
 *
 * - **PAT NEVER appears in error.message** (THREAT-MODEL §3.13).
 *   The grep test in `tests/composition/gitea-client.test.ts`
 *   asserts the seeded PAT bytes never surface in any thrown
 *   error message string. The implementation routes the PAT
 *   through the Authorization header ONLY; everything else
 *   (URL, status, response body excerpt) is safe to surface.
 * - The 401/403 paths return a sanitized message — Gitea's own
 *   401 body sometimes echoes scope info that's safe but the
 *   message doesn't include the PAT.
 * - HTTPS is the operator's responsibility (the URL comes from
 *   `GITEA_BASE_URL` env). The client doesn't downgrade to
 *   HTTP itself.
 */
import type {
  GiteaClient,
  GiteaWhoamiResult,
} from "../admin-api/auth.js";

const TEAMS_PAGE_LIMIT = 50;

interface GiteaUserResponse {
  readonly login?: unknown;
}

interface GiteaTeamResponse {
  readonly name?: unknown;
  readonly organization?: { readonly username?: unknown };
}

export interface CreateGiteaClientArgs {
  readonly baseUrl: string;
  /** @internal Test seam — defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Build a production GiteaClient. The constructed client holds
 * `baseUrl` + the fetch impl; per-request PAT is passed in by
 * the verifyAdmin preHandler.
 */
export function createGiteaClient(
  args: CreateGiteaClientArgs,
): GiteaClient {
  const fetchFn = args.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const baseUrl = args.baseUrl.replace(/\/+$/, "");

  return {
    async whoami(pat: string): Promise<GiteaWhoamiResult> {
      // 1) /user → username.
      const userRes = await callGitea(fetchFn, baseUrl, "/api/v1/user", pat);
      const userJson = (await safeJson(userRes)) as GiteaUserResponse;
      const username = typeof userJson.login === "string" ? userJson.login : "";
      if (username.length === 0) {
        throw new Error(
          `gitea whoami: /api/v1/user returned no 'login' field (status ${userRes.status})`,
        );
      }

      // 2) /user/teams → slug list. Gitea paginates (default 30
      //    per page); we ask for the max and stop after one
      //    page in v0.1 (an operator who's in 50+ teams is
      //    unusual; if it becomes a real case the loop here
      //    walks `Link: rel=next`).
      const teamsRes = await callGitea(
        fetchFn,
        baseUrl,
        `/api/v1/user/teams?limit=${TEAMS_PAGE_LIMIT}`,
        pat,
      );
      const teamsJson = (await safeJson(teamsRes)) as ReadonlyArray<GiteaTeamResponse>;
      if (!Array.isArray(teamsJson)) {
        throw new Error(
          `gitea whoami: /api/v1/user/teams returned non-array (status ${teamsRes.status})`,
        );
      }
      const teams: string[] = [];
      for (const t of teamsJson) {
        const teamName = typeof t.name === "string" ? t.name : "";
        const orgName =
          typeof t.organization?.username === "string"
            ? t.organization.username
            : "";
        if (teamName.length === 0) continue;
        // Push BOTH forms so the operator can reference the
        // team by `<team>` OR `<org>/<team>` in `ADMIN_TEAM_SLUG`.
        // Pushing both is safe — `Array.includes` on the
        // verifyAdmin side just needs ONE to match.
        teams.push(teamName);
        if (orgName.length > 0) {
          teams.push(`${orgName}/${teamName}`);
        }
      }

      return { username, teams };
    },
  };
}

/**
 * Wrapped fetch that:
 *   - prepends baseUrl,
 *   - sets `Authorization: token <pat>` (Gitea's convention —
 *     also accepts `Bearer`, but `token` matches the docs),
 *   - throws on non-2xx WITHOUT including the PAT bytes,
 *   - never logs the PAT or echoes it in the thrown message.
 */
async function callGitea(
  fetchFn: typeof fetch,
  baseUrl: string,
  path: string,
  pat: string,
): Promise<Response> {
  const url = `${baseUrl}${path}`;
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "GET",
      headers: {
        // Gitea convention: `Authorization: token <pat>`. Note
        // the literal "token" prefix.
        authorization: `token ${pat}`,
        accept: "application/json",
      },
    });
  } catch (err) {
    // Network-level failure. Don't reveal the PAT — only the
    // URL + the underlying error class name.
    const cause = err instanceof Error ? err.message : String(err);
    // Defensive grep — even if `cause` somehow contained the
    // PAT (it shouldn't), strip it.
    throw new Error(
      `gitea fetch failed: ${url} (${stripPat(cause, pat)})`,
    );
  }
  if (!res.ok) {
    // Read response body for context but cap + sanitize.
    const bodyText = await res
      .text()
      .then((s) => s.slice(0, 200))
      .catch(() => "");
    throw new Error(
      `gitea ${path} returned ${res.status}: ${stripPat(bodyText, pat)}`,
    );
  }
  return res;
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `gitea response was not valid JSON (status ${res.status}, ${text.length} bytes)`,
    );
  }
}

/**
 * Defensive: scrub the PAT from any string we're about to
 * throw. Even if `fetch`'s underlying impl somehow surfaces
 * the Authorization header in an error.message (e.g. a verbose
 * tracing layer), this strip prevents the leak.
 *
 * Exported for the grep test in
 * `tests/composition/gitea-client.test.ts`.
 */
export function stripPat(text: string, pat: string): string {
  if (pat.length === 0) return text;
  // Replace literal occurrences of the PAT. Use a global,
  // case-sensitive replace — Gitea PATs are 40-char hex; case-
  // insensitive would over-replace.
  return text.split(pat).join("[REDACTED:pat]");
}

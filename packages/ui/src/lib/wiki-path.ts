/**
 * Wiki-path helpers shared by the AgentsRunNowButton wiring
 * (PR-R3, phase-a appendix #10).
 *
 * Heartbeat citations and lint-finding paths are shaped like
 * `wiki-exec/ops/planning.md` — the FIRST segment IS the domain
 * slug. The "Refresh now" / "Re-run lint" buttons need to infer
 * the dispatch domain from one of those paths so they can target
 * the right `agent_instances` row without an extra UI query.
 *
 * The regex MIRRORS the kebab-case constraint enforced by the
 * dispatch route (see `engine-self-operating/admin-api/routes/
 * agents-dispatch.ts` `SLUG_PATTERN`). A path whose leading
 * segment doesn't match returns null so the caller can suppress
 * the button rather than dispatch against a guessed/malformed
 * domain.
 */

/** Kebab-case domain slug — must match the server-side
 *  `SLUG_PATTERN` so we never propose a slug the dispatch route
 *  would reject. */
const DOMAIN_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

/** Return the first path segment when it looks like a kebab-case
 *  domain slug; otherwise null. Empty / malformed paths return
 *  null too. */
export function extractDomainSlugFromPath(path: string): string | null {
  const first = path.split("/")[0];
  if (first === undefined || first.length === 0) return null;
  if (!DOMAIN_SLUG_PATTERN.test(first)) return null;
  return first;
}

/**
 * Operator PAT extraction (phase-a appendix #2).
 *
 * The domain-create + binding-create routes need the operator's
 * Gitea PAT to provision repos as the caller — not as a separate
 * admin token. The PAT is already validated by `verifyAdmin` (it
 * resolved the team membership upstream); this helper re-reads
 * the same Bearer header so the route can pass the bytes
 * directly to `provisionDomainRepo`.
 *
 * The PAT is held in request-lifetime scope ONLY:
 *   - never persisted to disk or DB
 *   - never logged (THREAT-MODEL §3.6 invariant 11)
 *   - never recorded in audit metadata
 *   - scrubbed from any thrown error message by the
 *     provisioning helper itself
 *
 * This is a deliberate departure from PR 28's auth.ts pattern
 * (which keeps PAT bytes inside the cache and only exposes a
 * hashed-key form). Provisioning needs the raw PAT to
 * authenticate against Gitea — that's the §1424 sanctioned
 * exception.
 */
import type { FastifyRequest } from "fastify";

/** Pull the raw PAT out of the `Authorization: Bearer <pat>`
 *  header. Returns undefined when the header is missing or
 *  malformed — `verifyAdmin` would have rejected upstream so
 *  reaching this point with no PAT is a safety-net case. */
export function extractOperatorPat(req: FastifyRequest): string | undefined {
  const raw = req.headers["authorization"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  const match = /^Bearer\s+(\S+)$/.exec(value);
  return match?.[1];
}

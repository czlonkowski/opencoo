/**
 * scrubPat — redact known credential patterns from error strings.
 *
 * Used in `last_error` truncation (THREAT-MODEL §3.6 invariant 11:
 * no credential bytes in errors). The truncation pipeline is:
 *   `scrubPat(rawError).slice(0, 200)`
 *
 * Patterns (ordered most-specific first to avoid double-replace):
 *   1. Bearer token: `Bearer ` followed by any non-space run.
 *   2. Asana PAT: `1/` followed by ≥16 digits.
 *   3. Gitea PAT: exactly 40 hex characters (a-fA-F0-9).
 *      These often appear as `Authorization: token <40-hex>`.
 *   4. Generic high-entropy alphanumeric token: ≥32 [a-zA-Z0-9] chars.
 *      Catches API keys, JWTs, and other bearer-style secrets.
 *
 * Ordinary prose (sentences, stack traces without secrets) passes
 * through unchanged. The function is pure — no side effects.
 *
 * v0.2 consideration: if a credential pattern surfaces that this
 * regex set doesn't catch, add it here AND add a test case.
 */

// 1. Bearer <token> — non-greedy to stop at whitespace boundaries.
const BEARER_RE = /Bearer\s+\S+/g;

// 2. Asana PAT: literal `1/` followed by ≥16 consecutive digits.
const ASANA_PAT_RE = /1\/\d{16,}/g;

// 3. Gitea PAT: exactly 40 consecutive hex chars (any case).
//    Anchored to word-boundary equivalent via negative look-around so
//    we don't match substrings of longer tokens (those are caught by
//    the generic rule below).
const GITEA_PAT_RE = /\b[0-9a-fA-F]{40}\b/g;

// 4. Generic high-entropy alphanumeric: ≥32 consecutive [a-zA-Z0-9].
//    This catches JWTs (before the first dot), API keys, and any
//    other long-form token that doesn't fit the above patterns.
const GENERIC_TOKEN_RE = /[a-zA-Z0-9]{32,}/g;

const REDACTED = "[REDACTED]";

/**
 * Replace all recognised credential patterns in `s` with `[REDACTED]`.
 * Returns the sanitised string. Never throws.
 */
export function scrubPat(s: string): string {
  // Apply in order: Bearer first (catches `Bearer <anything>`),
  // then Asana PAT, then Gitea PAT, then generic.
  // Later passes are safe because `[REDACTED]` itself won't
  // match any of these regexes (no 32+ alphanum run, not 40-hex,
  // no `1/` + digits, no `Bearer `).
  return s
    .replace(BEARER_RE, REDACTED)
    .replace(ASANA_PAT_RE, REDACTED)
    .replace(GITEA_PAT_RE, REDACTED)
    .replace(GENERIC_TOKEN_RE, REDACTED);
}

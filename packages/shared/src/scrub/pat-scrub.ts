/**
 * scrubPat — redact known credential patterns from error strings.
 *
 * Used in `last_error` truncation (THREAT-MODEL §3.6 invariant 11:
 * no credential bytes in errors). Most callers should use the
 * `safeErrorMessage(err)` wrapper from `./safe-error.ts` rather
 * than inlining `scrubPat(rawError).slice(0, ERROR_MESSAGE_MAX_LENGTH)`
 * — the wrapper is the single source of truth for the
 * scrub-and-cap shape (PR-P3, phase-a appendix #8).
 *
 * Patterns (ordered most-specific first to avoid double-replace):
 *   1. Bearer token: `Bearer ` followed by any non-space run.
 *      Case-insensitive — HTTP auth schemes are case-insensitive (RFC 7235).
 *   2. Asana PAT: `1/` followed by ≥16 digits.
 *   3. Gitea PAT: exactly 40 hex characters (a-fA-F0-9).
 *      These often appear as `Authorization: token <40-hex>`.
 *   4. JWT: three base64url segments separated by dots (header.payload.sig).
 *      Matched as a unit before the generic rule so short headers (<32 chars)
 *      aren't left unredacted.
 *   5. Generic high-entropy token: ≥32 [a-zA-Z0-9_-] chars.
 *      Catches API keys and other bearer-style secrets not covered above.
 *
 * Ordinary prose (sentences, stack traces without secrets) passes
 * through unchanged. The function is pure — no side effects.
 *
 * v0.2 consideration: if a credential pattern surfaces that this
 * regex set doesn't catch, add it here AND add a test case.
 */

// 1. Bearer <token> — case-insensitive (RFC 7235 auth schemes are
//    case-insensitive), non-greedy to stop at whitespace boundaries.
const BEARER_RE = /Bearer\s+\S+/gi;

// 2. Asana PAT: literal `1/` followed by ≥16 consecutive digits.
const ASANA_PAT_RE = /1\/\d{16,}/g;

// 3. Gitea PAT: exactly 40 consecutive hex chars (any case).
//    Anchored to word-boundary equivalent via negative look-around so
//    we don't match substrings of longer tokens (those are caught by
//    the generic rule below).
const GITEA_PAT_RE = /\b[0-9a-fA-F]{40}\b/g;

// 4. JWT: three base64url segments separated by dots (header.payload.sig).
//    Each segment uses the base64url alphabet [A-Za-z0-9_-]; the minimum
//    segment length is 4 chars. Matched before the generic rule so the
//    full token is captured as one unit.
const JWT_RE = /[a-zA-Z0-9_-]{4,}\.[a-zA-Z0-9_-]{4,}\.[a-zA-Z0-9_-]{4,}/g;

// 5. Generic high-entropy token: ≥32 consecutive [a-zA-Z0-9_-] chars.
//    The character class includes `-` (at end to be literal) and `_`
//    so that base64url-encoded values (partial JWT segments, API keys)
//    are also caught.
//    WARNING: the generic rule biases toward false-positive redaction;
//    do not call scrubPat() on diagnostic identifiers like content
//    hashes or git refs — they will be redacted even though they are
//    not secrets.
const GENERIC_TOKEN_RE = /[a-zA-Z0-9_-]{32,}/g;

const REDACTED = "[REDACTED]";

/**
 * Replace all recognised credential patterns in `s` with `[REDACTED]`.
 * Returns the sanitised string. Never throws.
 */
export function scrubPat(s: string): string {
  // Chained replaces are safe: `[REDACTED]` matches none of these
  // regexes (no 32+ alphanum run, not 40-hex, no `1/` + digits,
  // no `Bearer `, no JWT pattern) so later passes can't double-redact
  // a placeholder.
  return s
    .replace(BEARER_RE, REDACTED)
    .replace(ASANA_PAT_RE, REDACTED)
    .replace(GITEA_PAT_RE, REDACTED)
    .replace(JWT_RE, REDACTED)
    .replace(GENERIC_TOKEN_RE, REDACTED);
}

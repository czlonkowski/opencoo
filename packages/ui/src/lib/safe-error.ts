/**
 * `safeErrorMessage` — coerce-and-cap helper for surfacing fetch errors
 * to the operator without leaking credential bytes or unbounded payloads.
 *
 * PR-W8 (phase-a appendix #15) — Reports diagnostic surface.
 *
 * This mirrors the contract of `@opencoo/shared/scrub`'s `safeErrorMessage`
 * helper, but lives in the UI package because `packages/ui/` is a leaf
 * (it intentionally does not depend on `@opencoo/shared`; the management
 * UI is a single React SPA served from `engine-self-operating`'s
 * static-ui handler, not a workspace-internal consumer). The shared
 * package's scrub regex is server-side only — secrets that flow to the
 * browser are already filtered by the admin-API auth gate, and the only
 * credential-shaped string the UI normally sees is the user's own PAT
 * inside its sessionStorage. We still cap + strip a Bearer-token prefix
 * defensively so a fetch error formed from a request URL or header echo
 * cannot blurt the PAT back at the operator on screen.
 */

const ERROR_MESSAGE_MAX_LENGTH = 200;

/** Strip `Bearer <token>`, `Basic <b64>`, and any `authorization:`
 *  header echo from an error message so a defensive log of the
 *  failing request can't render the PAT (or any other auth scheme's
 *  secret) in the diagnostic panel.
 *
 *  - Case-insensitive on the scheme name (`bearer` / `Bearer`).
 *  - Token half matches `\S+` so we don't anchor on a charset that
 *    misses base64-padded or scheme-specific encodings.
 *  - The `authorization:` echo redacts everything up to a header
 *    delimiter (newline, comma, or semicolon) — important because
 *    `Basic <b64>` contains the credential in the value half AFTER
 *    a space, so a token-shaped match would leave the b64 visible.
 *
 *  Copilot triage on PR #148 surfaced both shortfalls; the regex
 *  set here is what the server-side `scrubPat` analogue would
 *  approximate without the full credential-pattern import surface
 *  (UI is a leaf and intentionally doesn't depend on
 *  `@opencoo/shared`). */
function scrubAuth(raw: string): string {
  // `[^\s,;]+` (not `\S+`) is deliberate — `\S+` would consume the
  // trailing comma/semicolon that separates this credential token
  // from the next header value, collapsing them into the redacted
  // span and stripping the harmless tail of the log line.
  return raw
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replace(/authorization:\s*[^\r\n,;]+/gi, "authorization: [REDACTED]");
}

/** Scrub credential-shaped substrings + cap at
 *  `ERROR_MESSAGE_MAX_LENGTH` chars. Pure; never throws. Mirrors
 *  `@opencoo/shared/scrub`'s `safeErrorMessage`. */
export function safeErrorMessage(err: unknown): string {
  let raw: string;
  if (err instanceof Error) {
    raw = err.message;
  } else if (typeof err === "string") {
    raw = err;
  } else {
    try {
      raw = String(err);
    } catch {
      raw = "[unstringifiable error value]";
    }
  }
  return scrubAuth(raw).slice(0, ERROR_MESSAGE_MAX_LENGTH);
}

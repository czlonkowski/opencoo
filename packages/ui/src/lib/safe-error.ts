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

/** Strip `Bearer <token>` and `Authorization: <header>` fragments from
 *  an error message so a defensive log of the failing request doesn't
 *  render the PAT in the diagnostic panel. */
function scrubAuth(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]{8,}/g, "Bearer [REDACTED]")
    .replace(/authorization:\s*[^\s,;]+/gi, "authorization: [REDACTED]");
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

/**
 * CSRF helpers (PR 29 / plan #131).
 *
 * The double-submit pattern from PR 28 expects:
 *   1. The server set `opencoo_csrf=<tok>; SameSite=Strict;
 *      Secure; Path=/api/admin` (NOT HttpOnly, by design).
 *   2. The SPA reads the cookie and mirrors it as
 *      `X-CSRF-Token` on every state-changing fetch.
 *
 * `getCsrfTokenFromCookie` parses `document.cookie` for the
 * `opencoo_csrf` value. Tolerant to whitespace + cookie
 * ordering. The fetch wrapper in `api.ts` calls this on every
 * mutating request.
 *
 * On 403 csrf_invalid the fetch wrapper auto-retries ONCE
 * after refetching `/api/admin/_csrf`.
 */
const COOKIE_NAME = "opencoo_csrf";

export function getCsrfTokenFromCookie(): string | null {
  if (typeof document === "undefined") return null;
  const raw = document.cookie ?? "";
  const parts = raw.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${COOKIE_NAME}=`)) {
      const value = trimmed.slice(COOKIE_NAME.length + 1);
      if (value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1);
      }
      return value;
    }
  }
  return null;
}

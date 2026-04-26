/**
 * PAT storage (PR 29 / plan #131, decision Q3).
 *
 * v0.1 stashes the operator's Gitea PAT in `sessionStorage`
 * keyed `opencoo_pat`. Cleared automatically on tab close —
 * acceptable XSS trade-off for v0.1 (single-operator,
 * tab-scoped, behind admin team). Documented in README.
 *
 * v0.2 explores HttpOnly + same-site session cookies once
 * we run an OAuth dance against Gitea.
 *
 * Tests (jsdom) and SSR contexts where `sessionStorage` is
 * undefined: every accessor short-circuits to a no-op /
 * undefined return so consumers don't crash.
 */
const PAT_KEY = "opencoo_pat";

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    // Some sandboxed contexts deny storage access — fail
    // gracefully so the UI can still render the PAT prompt.
    return null;
  }
}

export function getPat(): string | null {
  return safeStorage()?.getItem(PAT_KEY) ?? null;
}

export function setPat(pat: string): void {
  if (pat.length === 0) return;
  safeStorage()?.setItem(PAT_KEY, pat);
}

export function clearPat(): void {
  safeStorage()?.removeItem(PAT_KEY);
}

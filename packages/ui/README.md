# @opencoo/ui

Management UI for opencoo — React 19 SPA built with Vite,
served by `engine-self-operating` from `dist/ui/`. Talks to
`/api/admin/*` via the Bearer-PAT + CSRF flow established in
PR 28.

## Status

- v0.1 (PR 29 / plan #131). First user-facing UI PR.
- Four tabs: Domains, Sources, LLM Policy, Prompts.
- Vitest + JSDOM unit tests for the load-bearing flows
  (`CredentialForm` masks `secret: true` fields,
  `DiffPreviewDialog` countdown + apply, `fetchAdmin`
  CSRF auto-retry + auth-error mapping).
- Playwright spec stubbed; live-browser e2e lands in PR 32.

## Design system

Every visual references a CSS var from
`design_system/colors_and_type.css` (copied into
`src/styles/colors_and_type.css`). NO color literals; NO
new font families; NO gradients, drop-shadows for elevation,
pills, backdrop-blur, or emoji per CLAUDE.md "Design system"
hard-nos.

The accent budget:
- `--advisory` (Advisory Amber) — agent layer ONLY.
  Persistent debug banner is the canonical advisory channel.
  Under 10% of any screen.
- `--wiki` (Wiki Teal) — compiled-knowledge chrome ONLY
  (sovereignty diff border, prompt versions).
- `--alert` (Alert Red) — destructive / flagged items.
  Form-field errors, illegal transitions.
- `--healthy` (Healthy Green) — ok / compiled state.

The single motion loop is the heartbeat pulse on the operate
glyph (`--heartbeat-dur: 1600ms`). Everything else is one-shot
ease-out via `--ease-write` or `--ease-transform`.

## Auth + storage trade-off

The operator pastes their Gitea personal access token (PAT)
on first paint. We stash it in `sessionStorage` under
`opencoo_pat` so:
- it disappears when the tab closes (no persistence to disk
  across sessions),
- it does NOT travel as a cookie (no automatic CSRF-via-cookie
  exposure),
- it IS readable by JS in the same origin — meaning **a
  malicious script execution in this origin can exfiltrate
  the token**.

We accept this trade-off for v0.1 because:
- the UI is single-operator, behind admin-team membership,
- there is no cross-site script surface yet (no user-generated
  HTML, no embedded YouTube, etc.),
- v0.2 explores `HttpOnly` session cookies once the engine
  runs an OAuth dance against Gitea.

If you're operating opencoo in a multi-tenant or third-party-
integration context where the threat model differs, file an
issue — we'll prioritise the v0.2 OAuth surface.

## Dev / build / test

```sh
# Dev server (proxies /api to engine on :4001):
pnpm --filter @opencoo/ui dev

# Build (emits to packages/engine-self-operating/dist/ui/):
pnpm --filter @opencoo/ui build

# Unit tests (Vitest + JSDOM):
pnpm --filter @opencoo/ui test

# E2E tests (Playwright; needs Chromium — install via `npx playwright install`):
pnpm --filter @opencoo/ui test:e2e
```

## Routes

- `Domains` — read-only listing of every domain row.
- `Sources` — listing of source-binding rows (PR 28).
- `LlmPolicy` — per-domain policy editor with sovereignty-diff
  confirm (PR 28 token primitives + new `/preview` and
  `/apply` endpoints in this PR).
- `Prompts` — read-only manifest of every prompt-name × locale
  shipped with this build.

## i18n

`react-i18next` over `src/locales/{en,pl}.json`. The `en` is
canonical; `pl.json` is a placeholder per `architecture.md`
§17 Resolved (UI i18n). Real Polish translations land in v0.2.

## CSRF + auto-retry

`fetchAdmin` (in `src/lib/api.ts`) is the only sanctioned
admin-API entry point. It:
- attaches `Authorization: Bearer <PAT>` from sessionStorage,
- mirrors `opencoo_csrf` cookie as `X-CSRF-Token` on mutating
  requests,
- silently re-fetches `/api/admin/_csrf` and retries the
  original request once on 403 csrf_invalid,
- maps 401/403 → `ApiAuthError`, 4xx-other → `ApiValidationError`,
  5xx/network → `ApiTransientError`.

Routes consume the wrapper directly; they don't see the
auto-retry mechanic.

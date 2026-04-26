# @opencoo/cli

Operator CLI for opencoo — `opencoo migrate / setup / doctor /
source test / source forget / recompile` (PR 30 / plan #135).

## Status

- v0.1 (PR 30 / plan #135). Final §1.2.7 PR.
- 6 verbs: bootstrap, diagnose, recompile.
- Built with `commander` (zero runtime deps), `picocolors` for
  ANSI, `prompts` for interactive flows.
- Vanilla `fetch` (Node 22 global) — no `undici` dep.

## Verbs

```sh
opencoo migrate [--skip-migrate]
  Apply Drizzle migrations against DATABASE_URL. v0.1 engines
  do NOT auto-migrate at boot — run this explicitly per the
  runbook. `--skip-migrate` is reserved for v0.2.

opencoo setup [--yes]
  Interactively write a .env file (mode 0600). The prompt
  collects the minimal env: DATABASE_URL, REDIS_URL,
  ENCRYPTION_KEY (generated if blank), PORT, GITEA_URL,
  ADMIN_TEAM_SLUG, SESSION_HMAC_KEY (generated), GITEA_BASE_URL.
  --yes seeds from existing env (CI mode).

opencoo doctor [--json] [--admin-pat <pat>]
  Print engine + DB + Gitea team health checks. Lists every
  internet-facing surface the operator should gate behind a
  reverse proxy (THREAT-MODEL §3.15). Errors → exit 1;
  warn-only → exit 0. NEVER prints credential VALUES.

opencoo source test <binding-id>
  Validate a binding's adapter config + credentials end-to-end.
  v0.1 stops at adapter construction success — production
  scan() requires the engine harness (Drive's googleapis
  client, n8n's REST client, etc.) which the CLI doesn't bundle.

opencoo source forget <binding-id> --executor <username> [--dry-run]
  Disable a binding + purge its `ingestion_intake` and
  `webhook_events` rows. Writes `erasure_log` rows. NEVER
  rewrites Gitea wiki history — Lint catches the orphan
  citations on its next pass. Non-interactive without
  --dry-run → exit 1 (TTY guard prevents accidental destructive
  cron invocations).

opencoo recompile <domain:page-path | --all-in-domain <slug>>
                  --executor <username>
  Queue a wiki-page recompile via the engine-ingestion worker.
  Writes `erasure_log` rows. The CLI does NOT run compile
  in-process — it audits the request and relies on the worker
  to pick it up.
```

## Exit codes

- `0` — success (or warning-only output to stderr).
- `1` — operator error (bad flags, missing required env, TTY
  guard tripped, binding not found).
- `2` — runtime / integration failure (DB unreachable, Gitea
  HTTP error, credential decrypt failure).

## Env vars consumed

- `DATABASE_URL` (+ `_FILE`) — required for every verb except
  `setup`.
- `ENCRYPTION_KEY` (+ `_FILE`) — required for `source test`
  (resolves the binding's credential via `DrizzleCredentialStore`).
- `OPENCOO_ADMIN_PAT` — fallback for `doctor --admin-pat`
  team-check. Allow-listed in `no-feature-env-vars`.
- `ADMIN_TEAM_SLUG`, `GITEA_BASE_URL` — read by `doctor` for
  the team-check.

## Security pins

- **`source forget` non-interactive without --dry-run → exit 1.**
  TTY check via `process.stdin.isTTY`. Prevents an unattended
  cron from blowing away an operator's binding.
- **`source forget` interactive prompts for confirmation:**
  `Type "<domain>/<adapter>" to confirm:`. Empty / wrong
  → cancel.
- **`source forget` writes `erasure_log` rows BEFORE the
  matching DELETE.** A crash mid-way leaves an audit trail.
- **`doctor` NEVER prints credential VALUES.** Uses the
  `inspectSecret` + `formatSecret` helpers — values are
  reported as `<NAME>: env (N bytes)` or `<NAME>: file=<path>
  (N bytes)`.
- **GiteaClient never leaks the PAT in error.message.** The
  internal `stripPat` helper scrubs every thrown message.
  Grep-tested in `engine-self-operating/tests/composition/gitea-client.test.ts`.

## Production composition root (PR 30 Part B)

The CLI lives alongside the engine-self-operating composition
root that PR 30 added in `packages/engine-self-operating/src/composition/`:

- `env.ts` — loads `ADMIN_TEAM_SLUG` + `SESSION_HMAC_KEY` +
  `GITEA_BASE_URL` + `LLM_DEBUG_LOG` (with `_FILE` Docker-
  secrets variants).
- `gitea-client.ts` — fetch-based GiteaClient implementing the
  `whoami` contract from PR 28's admin-API.
- `server-factory.ts` — productionServerFactory that registers
  admin-API BEFORE static-UI (the static-UI plugin's
  setNotFoundHandler would otherwise intercept admin paths).

`packages/engine-self-operating/src/start.ts` was updated to
detect the production env and swap in `productionServerFactory`
when all three env vars are set; missing vars fall back to the
boot-tolerant `staticUiOnlyServerFactory` with a clear
`admin_api.disabled` log line.

## Tests

```sh
pnpm --filter @opencoo/cli test
  # per-command parse + load-bearing security invariants
```

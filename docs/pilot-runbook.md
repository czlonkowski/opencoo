# pilot runbook

## What this document is

This runbook walks an operator from a fresh checkout to a working pilot deployment with real-data webhook ingestion confirmed end-to-end. it is the only checklist the operator needs to follow before declaring the deployment "pilot-ready". scheduled-agent autonomy (Heartbeat / Lint / Surfacer firing on cron) is partially deferred — see §8 — so the v0.1 ready signal is "webhook → wiki write end-to-end on the binding the operator just configured", not "every agent fires unattended".

The doc is operator-facing and follows the same voice rules as the management UI: lowercase `opencoo`, no marketing language, technical and precise. when something does not work, §6 names the recovery path; when something does not exist yet, §8 names the gap.

Companion docs: `docs/ARCHITECTURE.md` (architectural shape), `THREAT-MODEL.md` (security invariants the operator gates the deployment against), `IMPLEMENTATION-PLAN.md` (phase-a ledger).

## 1. Pre-flight checklist

Bring the deployment substrate up first. opencoo does not ship its own substrate — it talks to existing Postgres / Redis / Gitea instances.

- **PostgreSQL 16+** reachable on a TCP socket. one database per opencoo instance; no separate read-replica needed in v0.1.
- **Redis 7+** reachable on a TCP socket. used as the BullMQ backing store; persistence settings are operator-owned (BullMQ recovers from `aof` on its own, but a snapshot loss costs in-flight ingestion jobs).
- **Gitea** reachable from the opencoo host. any recent Gitea release works; pin by image digest in operator-owned compose. opencoo writes to one repo per knowledge domain via a service-account PAT.
- **Ports**: `8080` free on the opencoo host (the engine binds Fastify here); `5432` / `6379` / `3000` free if the operator runs Postgres / Redis / Gitea on the local-dev `compose.yml` shipped in the repo. all three are operator-overridable.

### Required env vars

opencoo's env-var allow-list is short by design (THREAT-MODEL §2 invariant 9 — `no-feature-env-vars` ESLint rule enforces it). everything else is in Postgres + the management UI.

| Variable | Purpose | Generate / source |
|---|---|---|
| `DATABASE_URL` | Postgres DSN. | operator-owned. e.g. `postgres://opencoo:opencoo@localhost:5432/opencoo` |
| `REDIS_URL` | Redis URL. | operator-owned. e.g. `redis://localhost:6379` |
| `ENCRYPTION_KEY` | 32-byte hex symmetric key for the `CredentialStore` vault. | `openssl rand -hex 32` |
| `GITEA_URL` | Gitea base URL the engine writes wikis against. | operator-owned |
| `GITEA_PAT` | Service-account PAT with write scope on the wiki repos. | created in Gitea UI |
| `PORT` | Fastify bind port. | optional; defaults to `8080` |
| `ADMIN_TEAM_SLUG` | Gitea team whose members get admin-API access. | required when running the management UI |
| `SESSION_HMAC_KEY` | 32-byte base64 HMAC key for admin sessions. | `openssl rand -base64 32` |
| `GITEA_BASE_URL` | Gitea URL the admin-API uses for `/whoami`. | usually equal to `GITEA_URL` |

Optional:

- `OPENCOO_ADMIN_PAT` — Gitea PAT used by `opencoo doctor` to verify admin-team membership without `--admin-pat` on the command line.
- `LOG_LEVEL=debug` — verbose engine logs, useful for pilot triage. unset in steady-state production.
- `LLM_DEBUG_LOG=1` — surfaces full prompts + responses on the SSE bus and in `llm_usage_debug`. **never set in production** (THREAT-MODEL §2 invariant 11). the management UI displays a banner whenever the gate is on so reviewers know.
- per-provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OLLAMA_BASE_URL`) — wired by the `LlmRouter` lazily; only required for the providers the operator actually selects in domain LLM policy.

every var also accepts a `_FILE` suffix variant (Docker secrets pattern). `_FILE` wins when both are set.

## 2. First-boot sequence

Run from the repo root, with the env above present in `.env` or the shell:

```
pnpm install
pnpm build
opencoo migrate              # apply Drizzle migrations to the Postgres DSN
opencoo setup                # interactive: writes .env at mode 0600 if missing
opencoo agents seed          # idempotent INSERT of default Heartbeat/Lint/Surfacer rows
opencoo doctor               # verifies env + Postgres + Gitea + enumerates ingress paths
pnpm opencoo                 # boots the management UI + ingestion engine in one process
```

Per-command notes:

- `opencoo migrate` is idempotent — Drizzle tracks applied rows in `drizzle.__drizzle_migrations`. green output: `migrate: ok`.
- `opencoo setup` refuses to overwrite an existing `.env`. delete or rename first if rotating secrets.
- `opencoo agents seed` inserts one `agent_instances` row per scheduled-class agent (Heartbeat, Lint, Surfacer). Chat + Builder are on-demand and intentionally not seeded. re-running is a no-op.
- `opencoo doctor` returns exit 0 with all-green checks on a healthy fresh install. one yellow line on the Activity feed surface is expected on first boot — there are no events yet to enumerate. yellow on `gitea_team` means `OPENCOO_ADMIN_PAT` is unset; pass `--admin-pat <pat>` to verify admin-team membership.
- `pnpm opencoo` boots both engines in a single Node process. expected stdout: `opencoo: starting...` → `opencoo: started`. SIGTERM / SIGINT drains both engines in parallel within ~30s.

If composition of the ingestion engine fails (most often: missing `GITEA_PAT` or `ENCRYPTION_KEY`), `pnpm opencoo` continues running the management UI in `mode: 'probes-only'` — the operator gets the UI, the webhook receiver is unavailable until restart. the stderr line names the missing ingredient.

## 3. Bind a real Asana source

The pilot's first real binding. all UI paths assume the engine is running on `http://localhost:8080`.

1. Open `http://localhost:8080` and sign in. the admin-API uses Gitea OAuth; the operator must be a member of `ADMIN_TEAM_SLUG`.
2. Navigate to the **Sources** tab → click **+ New binding**.
3. Choose adapter **`asana`**. fill the form rendered from `asanaBindingConfigSchema`:
   - **Asana PAT** — service-account token with read access on the project. encrypted at rest via `CredentialStore`.
   - **Project gid** — the Asana project the engine watches.
   - **Workspace gid** *(optional)* — for cross-checks; leave unset for v0.1.
   - **Monitored project gids** *(optional but recommended)* — single-element array containing `Project gid`. when unset, every event for the bound credentials passes through; production deployments should set this.
   - **Snapshot mode** — defaults to `on-event`. produces a second `SourceEvent` per webhook with `content_kind: 'asana-project'`.
   - **Light summary enabled** — defaults to `false` (opt-in to avoid LLM cost on high-volume projects).
   - **Review mode** — defaults to `auto`. `auto` requires the redaction guard (default) wired into the ingestion path.
4. Click **Save**. the UI returns a webhook target URL of the shape `/webhooks/<binding-id>`.
5. Copy the URL into Asana's webhook configuration UI. Asana's webhook handshake (`X-Hook-Secret`) is handled automatically by the receiver (PR-F): the receiver echoes the secret back, persists it via `CredentialStore`, and updates `sources_bindings.webhook_secret_credentials_id`.
6. Confirm via the Sources tab — the binding's status pill should transition `configuring → ok` within ~30s. `last_event_at` populates on the first real delivery; `last_error` populates if the receiver rejects (signature mismatch, body over the 5MB cap, etc.).

Optional verification — confirm the receiver is reachable from outside the host:

```
curl -i https://<host>:<port>/webhooks/<binding-id> -X OPTIONS
```

CORS is intentionally not enabled on this path; the operator should expect a 4xx on OPTIONS but a TCP-level acknowledgement. anything timing out at the network layer is a reverse-proxy / firewall issue.

## 4. Real-data smoke

The load-bearing operational test. does the deployment actually work end-to-end?

1. **Trigger an event.** in the bound Asana project, create or update a task. if `monitoredProjectGids` is set, the task must belong to one of the listed projects. if the binding has a tag filter (project-level scope is enough for v0.1), use a tagged task.
2. **Watch the Activity feed.** in the management UI's **Activity** tab, within ~10s the operator should see two events stream in:
   - `source.event.received` — receiver acknowledged + verified the HMAC.
   - `ingestion.intake.created` — the scanner queue dequeued the event and persisted the `ingestion_intake` row.
3. **Watch for compile completion.** within ~30s a `compile.completed` event lands carrying the wiki path (e.g. `wiki-executive/projects/<project-name>.md`).
4. **Confirm the wiki page in Gitea.** navigate to `<GITEA_URL>/<org>/wiki-<domain-slug>/src/branch/main/<wiki-path>.md`. the page must show populated frontmatter (`schema_version`, `prompt_version`, `compiled_at`, `compiled_by_run_id`) and a `Worldview-Impact` git trailer on the commit.
5. **Confirm output delivery** *(if a binding has an `OutputAdapter` configured — typically `output-asana` for the comment-back loop)*. within ~10s of the wiki write, an `output.delivery.success` event appears on the Activity feed; the corresponding `output_deliveries` row is in Postgres with `status = 'sent'`. failed deliveries surface as `output.delivery.dlq`.

When all five markers are green, the smoke is green. proceed to the §9 sign-off checklist.

A scripted version of this probe ships at `scripts/smoke-real-data.ts` and is registered as `pnpm smoke:real-data`. it provisions a transient test domain + a generic-webhook binding, posts a signed fixture event, polls for the `webhook_events` and `ingestion_intake` rows, and tears down its scaffolding before exit. useful as a "is the deployment alive?" probe at any time after first boot, distinct from the real-Asana walkthrough above:

```
pnpm opencoo                 # in terminal 1
pnpm smoke:real-data         # in terminal 2; exits 0 in <90s on green
```

## 5. Common failures and how to recover

- **`doctor: ENCRYPTION_KEY` is `unset` or invalid.** regenerate via `openssl rand -hex 32`, write to `.env`, restart `pnpm opencoo`. the vault refuses keys < 32 bytes — that protects every encrypted credential row from a weak-key downgrade.
- **Binding status stuck at `configuring` for > 2 min.** check Asana's webhook delivery panel — the `X-Hook-Secret` echo must match opencoo's response. without it, the receiver returns 200 but does not persist the secret, and subsequent event deliveries fail HMAC verification with no clear stderr line. delete the Asana webhook + recreate.
- **Activity feed empty after a webhook delivery.** check `webhook_events` directly: `SELECT id, signature_ok, error_text FROM webhook_events ORDER BY received_at DESC LIMIT 5;`. `signature_ok = false` rows mean HMAC failed (likely a stale secret on the binding); set `LOG_LEVEL=debug` and look for `webhook_receiver.signature_invalid` in the engine stdout.
- **`ingestion_intake` row appears but no `compile.completed` event.** check Redis is reachable from the engine: `redis-cli -u "$REDIS_URL" ping`. check `pnpm opencoo` stderr for `ingestion_workers.close_failed` or any BullMQ connection error. if Redis was reachable but the worker silently quit, the ingestion engine likely fell back to `mode: 'probes-only'` — re-read the boot stderr for the composition-failure line.
- **`compile.completed` event but no wiki write.** confirm `GITEA_PAT` has write access on the target repo (Gitea logs a 403 on the engine side; the engine writes a `wiki_write.failed` line). if the PAT is admin-scoped but the repo doesn't exist yet, run `opencoo setup` to provision domain repos, or create them manually in Gitea and re-trigger.
- **`pnpm smoke:real-data` returns exit 2 with `webhook POST returned 401`.** the smoke script writes a plaintext credential row and signs the fixture with that secret; if the receiver decrypts via `CredentialStore`, the secrets won't match. this is a known v0.1 limitation of the smoke (named in the script's `--help`); the real-Asana flow above is not affected.

## 6. Rollback (design-partner cutover only)

When opencoo runs in parallel with an n8n pipeline that previously handled the same Asana project, the cutover surface is one binding at a time. to revert a single pipeline:

1. **Disable the binding.** Sources tab → click the binding → toggle `enabled` to `false`. inbound webhook events continue to be accepted (HMAC verified, `webhook_events` row written) but the scanner queue does not dispatch them, so no compile fires and no wiki write happens. this preserves audit and lets the operator inspect what would have ingested without commit.
2. **Re-enable the n8n parallel pipeline** that previously handled this Asana project. re-activation is operator-owned in the n8n UI; the workflow ID is named in the partner's deployment ledger. (per CLAUDE.md, do not name the partner's `docs/local/` workflow IDs in public artifacts; consult the partner-private ledger.)
3. **Verify n8n is processing** via the n8n execution log. typical recovery: < 5 minutes from the binding-disable click to the next n8n run.

Cutover policy: opencoo's binding stays enabled until the n8n equivalent is paused and reviewers sign off on opencoo's output quality. cutover is one pipeline at a time; never big-bang.

## 7. Verifying THREAT-MODEL invariants

Before declaring pilot-ready, the operator runs the following spot-check (mirrors THREAT-MODEL §5 PR checklist for the deployment surface):

- [ ] All `_FILE`-variant secrets resolve correctly: rename a value to its `_FILE` variant, point at a file, restart, verify `doctor` is still green.
- [ ] Admin-API requires Gitea team membership: log in as a non-`ADMIN_TEAM_SLUG` user, confirm `/api/admin/*` returns 403.
- [ ] Webhook 5MB body cap enforced: `curl -X POST` a 6MB payload at the binding URL, expect 413 from Fastify.
- [ ] CSRF cookie is `Path=/` and `SameSite=Strict`: open devtools on a logged-in admin session, confirm both attributes.
- [ ] No prompt content in `info`-level logs: `LOG_LEVEL=info pnpm opencoo`, trigger a webhook, grep stdout for `prompt_text` — should return empty.
- [ ] `LLM_DEBUG_LOG` banner shown in the UI when set: with `LLM_DEBUG_LOG=1`, the management UI displays a yellow banner on every page.

## 8. What's NOT yet automatic (known v0.1 limitations)

These are deliberate phase-a / phase-b deferrals. tracking each in the appendix #5 follow-up issue:

- **Heartbeat / Lint / Surfacer scheduled agents do not fire on cron yet.** `agents seed` writes the `agent_instances` rows with `schedule_cron` populated (PR-M2 wired this), but the `AgentRunnerRegistry` boots empty because production agent runners need an `HttpMcpToolClient` — that wiring is a phase-b PR (PR 23+). the `/api/admin/scheduler` route enumerates the seeded rows; it returns an empty `nextFireAt` until the registry is populated. there is no manual-trigger CLI today either; tracking this gap in the appendix #5 follow-up issue.
- **DLQ retry workers for `output_deliveries` are not automated.** failed deliveries surface as `output.delivery.dlq` SSE events with the row in Postgres at `status = 'failed'`. manual operator recovery is the v0.1 path: re-enable the binding or re-deliver via psql.
- **Per-domain LLM-policy aware scheduling defers to v0.2.** if a domain's LLM policy points at an unavailable provider, the scheduler dispatches anyway; the LLM router error-bubbles via `LlmPolicyViolationError`. operators can pause the domain manually via the management UI's Domains tab.
- **Cron timezone awareness defers to v0.2.** every `defaultScheduleCron` is UTC. operators in non-UTC offsets adjust the cron expression manually until v0.2 lands.
- **Scheduler UI in the management console defers to phase-b.** `/api/admin/scheduler` (read-only) is the v0.1 surface; operators inspect via curl or psql.
- **Self-boot mode for `pnpm smoke:real-data`** (`--boot` flag spawning `pnpm opencoo` as a child) is not implemented in v0.1 — the script assumes the operator runs `pnpm opencoo` in another terminal first. the script returns exit 1 with a clear message if `--boot` is passed.

## 9. Pilot sign-off checklist

Operator ticks each box before declaring the deployment pilot-ready:

- [ ] All required env vars set; `opencoo doctor` returns exit 0 with all checks green (or only the expected `gitea_team` warn when `OPENCOO_ADMIN_PAT` is unset).
- [ ] At least one source binding created via the management UI; status pill shows `ok`; `last_event_at` populated.
- [ ] Real webhook event observed end-to-end: `source.event.received` → `ingestion.intake.created` → `compile.completed` events all land on the Activity feed within 60s of the upstream trigger.
- [ ] Wiki page rendered in Gitea with populated frontmatter (`schema_version`, `prompt_version`, `compiled_at`, `compiled_by_run_id`) and a `Worldview-Impact` git trailer on the commit.
- [ ] Activity feed populated with at least 5 events; no console errors in the management UI; no red rows in `agent_runs`.
- [ ] PRD §5 success criteria 1, 2, 4, 6, 7, 8 verified manually:
  - **#1** — fresh `docker compose up -d` produces a bootable admin + a default domain without manual DB edits.
  - **#2** — an ingested PDF appears as a compiled wiki page with populated frontmatter and a `page_citations` row.
  - **#4** — per-domain LLM policy pinned to local Ollama rejects a cloud-provider call with a typed `LlmPolicyViolationError`.
  - **#6** — the prompt-injection corpus passes for every locale × agent.
  - **#7** — `wikiWrite` is the sole write path; ESLint boundary `no-direct-gitea-write` enabled.
  - **#8** — `engine-ingestion` and `engine-self-operating` do not import each other (`no-cross-engine-import`).
- [ ] Operator has read THREAT-MODEL §5 PR checklist + §7 residual risks list and signed off on the residuals as acceptable for the pilot's first weeks.
- [ ] Rollback path (§6) exercised at least once: a binding disabled, the n8n equivalent re-enabled, output verified, the binding re-enabled.

When every box is ticked, the deployment is pilot-ready. the partner's two-week soak begins; phase-b entry gate (`IMPLEMENTATION-PLAN.md` §2.1) opens after a sev-1-incident-free fortnight.

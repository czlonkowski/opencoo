# CHANGES-v0.1.md

> Operator-facing changelog for the `0.1.0-a` (phase-a) tag of `opencoo`.
> Phase-a is **34 merged PRs** (32 numbered rows + the §0 pre-coding gate + 2 appendix PRs) on `main` between repo init and commit `a780a99`.
> Format follows [Keep a Changelog](https://keepachangelog.com) loosely. PR numbers link to GitHub.
>
> This file is intended to be read alongside `IMPLEMENTATION-PLAN.md` (the architectural narrative + per-PR table) and `THREAT-MODEL.md` (the security-invariant reference). Where a row says "see plan §1.2.X", that's the canonical place for the deeper rationale.

---

## [0.1.0-a] - 2026-04-27 (planned)

Phase-a delivers **pilot-cutover parity + `catalog-workflows`**: `packages/shared/` foundations, the two engines (`engine-ingestion` + `engine-self-operating`), the seven first-party adapters, the five first-party agents (Heartbeat, Lint, Chat, Surfacer, Builder), the Review Dashboard server-side admin-API, the Vite + React 19 Management UI, the `@opencoo/cli` with seven verbs (six in PR 30 + the bare boot verb in #36), the prompt-injection corpus ship-blocker, and the e2e ship gate against compose-spun Gitea + Postgres + Redis.

Phase-a is the cutover surface for the design partner. **Phase-b** (`catalog-skills` + SkillMiner) and **phase-c** (partner Builder-skill overlay + marketplace live-fetch polish) are explicitly deferred to later tags per `IMPLEMENTATION-PLAN.md` §2 and §3.

### Added

#### Engines

- `@opencoo/engine-ingestion` — Fastify boot + BullMQ wiring + probe endpoints (`/health` is unconditional process-liveness 200; `/ready` runs Postgres + Redis + Gitea probes and returns 503 until all are healthy); intake + four-level dedupe + webhook receiver; classifier with XML spotlighting; compiler with atomic per-run `wikiWrite` + `page_citations` + `Worldview-Impact` git trailer; five scheduled pipelines (Scanner, Compilation Worker, Index Rebuilder, Review Dispatcher, Cleanup) (#15, #16, #17, #18, #19, #20).
- `@opencoo/engine-self-operating` — Fastify boot + bundled UI static host (one process, one port, one container); agent harness with `agent_runs` + memory-poisoning protection + destructive-MCP-tool deny-list; Heartbeat + Lint + Chat reader agents; Surfacer + Builder writer agents with the four-layer Gate-3 enforcement (type / schema / runtime / cross-package source-grep); worldview compilation pipeline with sovereignty spy + 24KB cap retry + debounce policy (#20, #21, #22, #23, #24, #25).

#### Shared packages (`packages/shared/`)

- `db` — Drizzle schemas owning every `pgTable`; the schema-ownership rule (`architecture.md` §14.4) is ESLint-enforced (#2, #3, #4).
- `logger` — JSON-per-line emitter with `ts`/`level`/`module`/`run_id`; never multi-line; raw prompts forbidden at `info` level (THREAT-MODEL §2 invariant 11) (#5).
- `errors` — `OpencooError` taxonomy with `errorClass: 'transient' | 'upstream-quota' | 'validation'` driving retry policy (#5).
- `text-normalize` — NFC + control-strip + fence-aware whitespace collapse; idempotent (#6).
- `credential-store` — AES-256-GCM, AAD-bound to credential ID, KMS-swappable behind a `CredentialStore` interface; `_FILE` Docker-secrets convention; `encryption_version` dispatcher reads old rows, writes always current (#7).
- `llm-router` — sole sanctioned LLM-call path; per-domain `llm_policy` enforcement; `local_only` sovereignty pin throws `LlmPolicyViolationError` before the call; `cost-tracker` with hard monthly spend cap that pauses the domain's BullMQ queues + throws `LlmBudgetExceededError`. **Closes the THREAT-MODEL §7 residual "no hard LLM spend cap"** (#8).
- `wiki-write` — sole sanctioned Gitea-write path; modes `'replace' | 'append' | 'delete'`; one call = one atomic Gitea commit; per-domain queue `concurrency: 1`; delete-mode daily cap (default 10) fails closed; commit-message tag enum (`[compiler]` / `[lint]` / `[index-rebuild]` / `[provision]` / etc.); cross-domain path defense-in-depth (#9).
- `prompts` — production prompts seeded from the design-partner PoC under `packages/shared/src/prompts/{en,pl}/`; `version-manifest.ts` const map enforces type-level pairing of new prompts with semver bumps (#19, #32, #34).
- `adapter-contract-tests` — three reusable contract suites: `sourceAdapterContract`, `outputAdapterContract`, `guardAdapterContract`. New adapters pass these or fail to merge (#11, #14, #26, #27).
- `adapter-registry` — `AdapterRegistry` / `SourceAdapterFactory` / `buildAdapterRegistry` contract in shared so the CLI bin and both engines build their own registries without circular dependency (#33).

#### MCP server

- `gitea-wiki-mcp-server` — REPOS configuration update + new `worldview://{domain}` and `worldview://company` resources; PAT-scope enforcement at the API layer; out-of-scope reads return uniform "not accessible" (THREAT-MODEL §3.14) (#10).

#### Adapters

- `@opencoo/converter-docling` — first `DocumentConverterAdapter`; sidecar process; `network_mode: none` recommended; fails closed on malformed input via `ConversionError`; emits `extraction_degraded` when known-tabular input produces zero GFM pipes (#11).
- `@opencoo/wiki-gitea` — Gitea-backed `WikiAdapter`; service-account git author on machine commits; `Co-authored-by:` on human-approved; queue-per-domain respected; 13-assertion shared contract suite (#13).
- `@opencoo/guard-redaction-regex` — first `GuardAdapter` with `role: 'redaction'`; 14 v1 patterns (Polish-PII-biased per the partner PoC) with checksum validators on PESEL / NIP / REGON / IBAN / Luhn; `redaction_events` rows store metadata only (THREAT-MODEL §3.3) (#14).
- `@opencoo/source-drive` — reference `SourceAdapter`; passes nine polling assertions + three webhook stubs in the shared contract suite (#26).
- `@opencoo/source-asana` — webhook-mode `SourceAdapter` (#27).
- `@opencoo/output-asana` — first `OutputAdapter`; nine-assertion `outputAdapterContract` (#27).
- `@opencoo/automation-n8n-mcp` — `AutomationAdapter` for n8n with all four Gate-3 layers (type-level on the engine port AND on the local `N8nLikeApi` surface; Zod schema rejects `active: true`; runtime hardcodes `active: false`; cross-package source-grep with token-aware comment stripping); vendored `n8n-skills` baseline at `vendor/n8n-skills/` (placeholder bundles in phase-a; live-fetch deferred to phase-c PR 43) (#28).
- `@opencoo/source-n8n` — REST scanner adapter; `content_kind: 'n8n-workflow'` bypasses `DocumentConverter`; `catalog-workflow` Compiler template is frontmatter-merge only with no LLM call; 1 MiB workflow ceiling; lossless round-trip across three fixture shapes (simple linear, branched-with-IF, loop-with-SplitInBatches) (#29).
- `@opencoo/source-fireflies` — webhook-mode `SourceAdapter` (HMAC + replay-stable `eventId` + non-empty title + collision guard + verbatim original-body `contentBytes` + meeting-title allowlist filter); `review_mode: 'approve'` default on transcription bindings (#30).

#### Agents (first-party, all five shipping in phase-a)

- **Heartbeat** — proactive daily report; max 5 alerts; reads worldview + own domain only; per-instance output-channel binding (CEO heartbeat cannot write to ops channel) (#22).
- **Lint** — weekly contradictions / stale pages / orphans / `allowed_paths: ["**"]` bindings / prompt-version drift / automation drift (#22).
- **Chat** — caller-PAT-scoped; cross-tenant SQL-leak fix (scope-domain SQL filter) (#23).
- **Surfacer** — read-only proposer; writes `automation_candidates` with `status: 'proposed'` (Gate 1, hardcoded — no caller can override) (#24).
- **Builder** — picks up only `status: 'approved'` candidates (Gate 2 — `requireApproved` throws); deploys workflows DISABLED (Gate 3 non-configurable, four layers); records `skills_used: {slug, version, sha, source}` per run (#24).
- Worldview compilation pipeline — per-domain `worldview.md` ≤ 6000 tokens; `Worldview-Impact` trailer triggers refresh with debounce (15m / 3h / 24h / never-solo); company worldview compiles from per-domain worldviews respecting source-domain LLM policy; synthetic high-impact events from Lint contradictions (#25).

#### Review Dashboard + Management UI

- Server-side admin-API plugin (#31): PAT-based auth via Gitea team membership; double-submit-cookie CSRF + `SameSite=Strict`; append-only `admin_audit_log` (`AUDIT_LOG_ACTIONS` closed Zod enum; writer rejects unknown verbs); stateless HMAC sovereignty-diff token with 5-min TTL bound to `(domainId, proposed)` payload; state-machine guards via atomic conditional UPDATE (409 on illegal transition); admin routes split between **read-only** GETs (`lint-findings`, `audit-log-read`) and **state-changing** POST/decision endpoints (`source-bindings`, `automation-candidates`, `marketplace-updates`, `logout`).
- `@opencoo/ui` package (#32): Vite + React 19 SPA bundled and served by `engine-self-operating` via `@fastify/static`; four admin tabs (Domains / Sources / LlmPolicy / Prompts); five design-system-bound components (`PatEntryModal`, `DiffPreviewDialog`, `DebugBanner`, `CredentialForm`, `PromptsDiffBanner`); `lib/{api,csrf,i18n,pat-store}.ts` with `fetchAdmin` as the sole admin-API entry point with auto-retry-once on 403 csrf_invalid; `i18next` + `react-i18next` setup with JSON locale resources under `packages/ui/src/locales/` (`en.json` populated, `pl.json` placeholder).
- LLM-policy editor (#32): server-canonical sovereignty diff; UI displays 5-min countdown; Apply disabled when expired or empty; replay protection tested.
- Admin audit-log read endpoint (#31, #32) records `audit_log.read` so operator-pulling-history is visible to the next reviewer.

#### CLI (`@opencoo/cli`)

`commander` (zero runtime deps) for parsing only — engines are not auto-migrated at boot (`--skip-migrate` is a v0.1 NO-OP for symmetry; the operator runbook is `setup → migrate → doctor`).

| Verb                      | Purpose                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opencoo` (no subcommand) | Long-running engine boot verb; orchestrates `start({env})` from `engine-self-operating`; SIGTERM/SIGINT graceful shutdown; idempotent close (#36)                                                                                                                                                             |
| `opencoo migrate`         | Apply Drizzle migrations from `packages/shared/drizzle/` (#33)                                                                                                                                                                                                                                                |
| `opencoo setup`           | Generate `.env` (mode 0600, atomic write) (#33)                                                                                                                                                                                                                                                               |
| `opencoo doctor`          | Diagnostics dump: required env vars present (values never print), DB reachable, migrations applied, optional Gitea-team-check via `--admin-pat <pat>` or `OPENCOO_ADMIN_PAT[_FILE]`, internet-facing-surface enumeration (THREAT-MODEL §3.15); `--json` for CI; errors exit 1, warnings exit 0 + stderr (#33) |
| `opencoo source test`     | Validate adapter construction from a binding config (no live API calls in v0.1) (#33)                                                                                                                                                                                                                         |
| `opencoo source forget`   | GDPR-erasure: intake purge + `erasure_log` rows + `sources_bindings.enabled = false` in single transaction; non-interactive without `--dry-run` exits 1; interactive prompts `Type "<domain>/<adapter>" to confirm:` (#33)                                                                                    |
| `opencoo recompile`       | Per-page (`domain:page-path`) or `--all-in-domain <slug>` (mutually exclusive) (#33)                                                                                                                                                                                                                          |

#### Prompt-injection corpus + phase-a e2e

- 86 generated fixtures (9 prompts × 2 locales × 6 categories with 22 documented inapplicables in `_skips.ts`); 5 universal invariants per fixture + 1 per-category check; byte-deterministic generator (`pnpm fixtures:regen` / `pnpm fixtures:check`); CI ship-blocker job `prompt-injection-corpus` on the default tier; manual `workflow_dispatch` real-LLM workflow (`injection-real-llm.yml`) refuses without `OPENROUTER_API_KEY` (#34).
- Phase-a e2e ship gate (#35): four e2e specs (`ingest-to-wiki`, `heartbeat`, `forget`, `domain-and-binding-create`) against compose-spun fixture Gitea (`gitea/gitea:1.22.6` hard-pinned) + Postgres 16 + Redis 7; in-memory `SourceAdapter` fixture; deterministic seed; `compose.e2e.yml` + `compose-controller`; separate `vitest.e2e.config.ts` lane; `.github/workflows/release.yml` runs `pnpm test:e2e` on `v*` and `0.1.0-*` tags + manual `workflow_dispatch`; under the 10-minute wall-clock budget (actual: ~17 seconds in-band).
- Domain + source-binding create flow (#37) — appendix #2 closing the regression PR 29 introduced (architecture.md §13 promised "Sources — list + add" but PR 29 shipped only `+ list`). New `+ New domain` and `+ New binding` modals on the Management UI; `POST /api/admin/domains` with Gitea repo provisioning under `${GITEA_PROVISION_ORG}` (default `opencoo`); `POST /api/admin/source-bindings` encrypting `auth` + `webhook_secret` halves separately for webhook adapters; `GET /api/admin/adapters` so the UI picker derives slugs from registry, not hardcoded list; `defaultReviewModeFor(adapter_slug, domain.class)` shared lookup per `architecture.md` §307 + §364; fail-closed transactional provisioning (any provisioning error rolls back the `domains` INSERT; orphan Gitea repos are operator-deletable); regression-locked by `pnpm test:e2e -- domain-and-binding-create`.

### Changed

This is the first tagged release; all surface is greenfield. There are no pre-existing externally-consumed APIs to break. Two reviewer-flagged adjustments worth surfacing for the design partner reading the cutover diff:

- **Wiki page frontmatter contract.** PRD §5 #2 wording lists `compiled_by_run_id` in wiki frontmatter, but the v0.1 Compiler emits that field on the `page_citations` row instead. Documented inline in `tests/e2e/ingest-to-wiki.test.ts`. Reconciliation flagged for a v0.1 patch (#35).
- **Agent-run cost columns.** `tokens_in` / `tokens_out` / `cost_usd` / `latency_ms` on `agent_runs` exist and are non-null per the schema, but the v0.1 harness writes zeros regardless of router metadata (per inline `harness.ts` comment). The heartbeat e2e asserts non-null + numeric, NOT non-zero — same forward-compat softening (#35).

### Schema

Eight Drizzle migrations under `packages/shared/drizzle/`. Run in order via `opencoo migrate`. Every table that joins the append-only invariant set is ESLint-pinned by `no-update-append-only` (THREAT-MODEL §2 invariant 8).

| File                                                      | Adds                                                                                                                                                                                                                               | Notes                                                                                                                                                                                          |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0000_init.sql`                                           | `domains`, `sources_bindings`, `users`, `credentials` + four enums (`domain_class`, `governance_cadence`, `review_mode`, `user_role`)                                                                                              | `domains.class ∈ {'knowledge', 'catalog-workflows', 'catalog-skills'}`; nullable `llm_budget_monthly_cap_usd numeric(10,2)`; slug regex constraint; locale allow-list (#2)                     |
| `0001_ingestion_tables.sql`                               | `catalog_candidate`, `erasure_log`, `ingestion_intake`, `llm_usage`, `miner_runs`, `miner_suppressions`, `page_citations`, `redaction_events`, `webhook_events` + 9 enums                                                          | Append-only invariant encoded; `ingestion_intake` UNIQUE on `(binding_id, source_doc_id, source_revision)` is the four-level idempotency key (#3)                                              |
| `0002_agent_runs_fk_backfill.sql`                         | `agent_definitions`, `agent_instances`, `agent_runs`, `automation_candidates`, `automation_deployments`, `marketplace_updates` + 5 enums; adds FK constraints `llm_usage.run_id` → `agent_runs.id` and `page_citations.compiled_by_run_id` → `agent_runs.id` (no UPDATE/backfill — both columns were already defined as nullable in 0001/0000) | `agent_runs.skills_used jsonb default '[]'::jsonb` carries `{slug, version, sha, source}` per Builder run (#4)                                                                                 |
| `0003_llm_usage_debug_and_domain_id.sql`                  | `llm_usage_debug` table (gated by `LLM_DEBUG_LOG=1`; `ON DELETE CASCADE` from `llm_usage`); `llm_usage.domain_id uuid` (nullable, ON DELETE SET NULL)                                                                              | Append-only; Cleanup pipeline TTL-prunes via `created_at` index (#8)                                                                                                                           |
| `0004_sources_bindings_last_scan_cursor.sql`              | `sources_bindings.last_scan_cursor text`                                                                                                                                                                                           | Polling cursor for Scanner pipeline (#19)                                                                                                                                                      |
| `0005_domains_is_aggregator.sql`                          | `domains.is_aggregator boolean default false` + partial UNIQUE INDEX `WHERE is_aggregator = true`                                                                                                                                  | At most one aggregator domain (compiles `company.md` from per-domain `worldview.md`); the partial unique index enforces it at the DB layer (#25)                                               |
| `0006_admin_audit_log_users_gitea_teams.sql`              | `admin_audit_log` table (append-only); `users.gitea_teams jsonb default '[]'`; `users.gitea_teams_refreshed_at timestamptz`                                                                                                        | `admin_audit_log` joined the `INVARIANT_8_TABLES` ESLint allow-list. Persisted CACHE of last-reconciled team list — `verifyAdmin`'s runtime source of truth is `giteaClient.whoami(pat)` (#31) |
| `0007_sources_bindings_webhook_secret_credentials_id.sql` | `sources_bindings.webhook_secret_credentials_id uuid` (nullable, FK to `credentials`)                                                                                                                                              | Webhook adapters store TWO encrypted credential rows: `credentials_id` (auth) AND `webhook_secret_credentials_id` (HMAC verifier) (#37)                                                        |

### Configuration

The UI-first-configuration invariant (CLAUDE.md "UI-first configuration"; THREAT-MODEL §2 invariant 9) is **non-negotiable**: `.env` carries only the operator secrets and bind-time toggles below. Every other knob lives in Postgres and is edited via the Management UI. The ESLint rule `no-feature-env-vars` enforces this against `process.env.*` reads outside the allow-list.

Allow-listed env vars as of `0.1.0-a` (every `_FILE` variant follows the same Docker-secrets convention — read once at boot, value must be readable by the engine UID):

**Core (PR 1, plus 5 in subsequent PRs)**

- `DATABASE_URL` / `DATABASE_URL_FILE` (#1)
- `ENCRYPTION_KEY` / `ENCRYPTION_KEY_FILE` — 32-byte strict; rejects 31 / 33 / 48-byte common hex-vs-base64 mistake (#1, enforced #7)
- `PORT` / `PORT_FILE` (#1)
- `ADMIN_BOOTSTRAP_TOKEN` / `ADMIN_BOOTSTRAP_TOKEN_FILE` (#1)
- `NODE_ENV` (#1)
- `LOG_LEVEL` (#5)
- `LLM_DEBUG_LOG` — `=1` enables `llm_usage_debug` writes AND a `_llmDebugLogActive: true` banner injected into admin-API JSON responses scoped to `/api/admin*` (#8, #31)
- `TELEMETRY_ENDPOINT` (#1)
- `CI` — set by every CI provider; consumed by Playwright's `forbidOnly` and vitest's reporter selection (#32)

**Engine-ingestion bootstrap (#15)**

- `REDIS_URL` / `REDIS_URL_FILE` — BullMQ
- `GITEA_URL` / `GITEA_URL_FILE` — wiki transport

**Engine-self-operating bootstrap (#20)**

- `UI_DIST_PATH` / `UI_DIST_PATH_FILE` — points at the bundled SPA dist directory at boot

**Admin-API auth + sovereignty-diff signing (#31, #33)**

- `ADMIN_TEAM_SLUG` / `ADMIN_TEAM_SLUG_FILE` — Gitea team whose members are admins
- `SESSION_HMAC_KEY` / `SESSION_HMAC_KEY_FILE` — base64-decoded; the composition root validates the decode at boot
- `GITEA_BASE_URL` / `GITEA_BASE_URL_FILE` — fetch-based `GiteaClient` target

**CLI doctor team-check (#33)**

- `OPENCOO_ADMIN_PAT` / `OPENCOO_ADMIN_PAT_FILE` — operator PAT for the optional `doctor` team-check; only the CLI consumes it; engine procs never read it. `--admin-pat <pat>` flag wins over both env paths

**Domain provisioning (#37, appendix #2)**

- `GITEA_PROVISION_ORG` / `GITEA_PROVISION_ORG_FILE` — Gitea organisation under which `POST /api/admin/domains` provisions repos. Defaults to `opencoo` when unset

Anything not on this list is a **rule failure**. The rule's error message (`process.env.<name> is not in the allow-list ...`) names the right next step: move the knob to Postgres, or add to `.env.example` + rule allow-list with THREAT-MODEL §2 sign-off.

#### Internet-facing surfaces

`opencoo doctor` enumerates these so the operator can gate them via reverse proxy. Source: `packages/cli/src/commands/doctor.ts` `INTERNET_FACING_PATHS`.

- `/health`
- `/ready`
- `/api/admin/_csrf`
- `/api/admin/adapters` (#37)
- `/api/admin/source-bindings`
- `/api/admin/automation-candidates`
- `/api/admin/marketplace-updates`
- `/api/admin/audit-log`
- `/api/admin/domains`
- `/api/admin/lint-findings`
- `/api/admin/prompts`
- `/api/admin/logout`
- `/api/admin/domains/:id/llm-policy/preview`
- `/api/admin/domains/:id/llm-policy/apply`
- `/webhooks/asana`
- `/webhooks/fireflies`
- `/webhooks/gitea`

### Security

Phase-a enforces the THREAT-MODEL §2 non-negotiable invariants at the type / lint / runtime levels. Every PR ran the §5 PR-checklist before request-for-review.

#### ESLint boundary rules (five, all gating CI)

Source: `tools/eslint-plugin-opencoo/src/rules/`.

- **`no-cross-engine-import`** — `packages/engine-ingestion/**` cannot import from `packages/engine-self-operating/**` and vice versa. Enforces `architecture.md` §2.5 / THREAT-MODEL §2 invariant 10 (#1).
- **`no-direct-gitea-write`** — non-provisioning code cannot import the Gitea API client directly; must go through `packages/shared/wiki-write`. Enforces THREAT-MODEL §2 invariant 2. The provisioning helper added in #37 was added to a single allow-list entry; the rule now enforces "wiki-write OR the named provisioning file, nothing else" (#1, tightened #37).
- **`no-direct-llm-sdk`** — `@ai-sdk/*` / Vercel AI SDK imports forbidden outside `packages/shared/src/llm-router/providers/**`. Enforces THREAT-MODEL §2 invariant 5 / `architecture.md` §4.1 / §12.1 (anti-LiteLLM-supply-chain rationale) (#1, scope narrowed #8).
- **`no-feature-env-vars`** — `process.env.*` outside the documented allow-list is a lint error. Forbids object-rest (`const { ...rest } = process.env`) AND dynamic computed access (`process.env[varName]`). Enforces THREAT-MODEL §2 invariant 9 (#1).
- **`no-update-append-only`** — `db.update()` and `db.delete()` against any table in `INVARIANT_8_TABLES` is a lint error. Allow-list as of `0.1.0-a`: `agentRuns` (with terminalisation carve-out), `pageCitations`, `redactionEvents`, `erasureLog`, `minerSuppressions`, `adminAuditLog`. Enforces THREAT-MODEL §2 invariant 8 (#4, extended #31).

#### THREAT-MODEL §2 invariants enforced in phase-a

| #   | Invariant                                                 | Layer enforced                                                                                                                |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | Adapters are leaves; no engine knowledge                  | Type / package-boundary                                                                                                       |
| 2   | `wikiWrite` is the sole sanctioned write path             | ESLint `no-direct-gitea-write` (with named-helper exception in #37)                                                           |
| 3   | Per-domain queue concurrency = 1                          | Runtime; `wiki-write` queue config                                                                                            |
| 4   | One classifier run = one Compiler call = one wiki commit  | Compiler atomicity test (#18)                                                                                                 |
| 5   | LLM calls go through `llm-router`; never direct SDK       | ESLint `no-direct-llm-sdk`                                                                                                    |
| 6   | All untrusted text wrapped in `<source_content>` envelope | Classifier + per-prompt fixture corpus (#34)                                                                                  |
| 7   | Builder NEVER calls activate / enable / toggle            | Four-layer Gate-3: type / schema / runtime / cross-package source-grep with token-aware comment stripping (#24, extended #28) |
| 8   | Append-only tables never UPDATE or DELETE                 | ESLint `no-update-append-only` (with `agent_runs` terminalisation carve-out)                                                  |
| 9   | No feature env vars                                       | ESLint `no-feature-env-vars`                                                                                                  |
| 10  | Engine processes don't import from each other             | ESLint `no-cross-engine-import`                                                                                               |
| 11  | Credentials resolved by ID, never inlined                 | `(credentialStore, credentialId)` factory shape; `@ts-expect-error` test pins on every adapter                                |

#### Closed THREAT-MODEL §7 residual risks

- **"No hard LLM spend cap"** — `cost-tracker.computeMonthToDateCost` + per-domain `llm_budget_monthly_cap_usd` + `LlmBudgetExceededError` + `QueuePauser` port. Re-enable requires admin action through the Management UI (#8).

#### Defense-in-depth (worth calling out)

- **`credential-store` byte-scan test** — runs the full lifecycle (write → read → rotate → read → delete) against both `InMemoryCredentialStore` AND `DrizzleCredentialStore` (via pglite) with two distinct sentinels; raw + base64 + JSON-reserialize scan across all captured log lines + forbidden-keys deny-list (`plaintext`, `secret`, `password`, `value`); liveness guard against an accidentally-silenced logger; `level: debug` to catch debug-only emission (#7).
- **`GiteaClient` PAT scrub** — `stripPat()` replaces all PAT occurrences with `<REDACTED>` in propagated error messages. Load-bearing grep test seeds `secret-pat-do-not-leak-1234567890abcdef`; asserts it doesn't surface in any thrown `Error` across 4xx / network drop / malformed JSON / missing-login response (#33).
- **`doctor` never prints credential VALUES** — load-bearing test seeds `ENC-KEY-do-not-leak-1234` + `hmac-secret`; asserts neither appears in stdout/stderr across human + JSON output (#33).
- **Sovereignty-diff token replay protection** — payload hash binds `(domainId, proposed)`; cross-payload + cross-domain replays rejected; tampered HMAC, expired TTL, malformed token (extra dots / missing parts / non-numeric expiresAt) all rejected (#31).
- **Pglite over pg-mem for crypto tests** — pg-mem corrupts `bytea` via UTF-8 re-encoding (`0xde 0xad 0xbe 0xef` → `0xef 0xbf 0xbd ...`), fatal for AES ciphertext. Phase-a tests use `@electric-sql/pglite` for byte-identical binary round-trip (#7).

### Deprecated

None in the first tagged release.

### Known Issues

Residual advisories from PR bodies (all flagged non-blocking; tracked for v0.2 hardening or follow-up PRs unless stated). The maintainer should triage these against pilot feedback before tagging `0.1.0`.

#### Cross-cutting

- **`commander` `--version`/`--help` double-print** — `packages/cli/src/bin.ts` catch block treats commander's `--help` / `--version` exit codes as parse failures, causing a double-print and exit 1 (cosmetic; pre-existing, not introduced in #36; flagged in #36).
- **`Sources` tab list-side query filters** — pre-existing gap from PR 29; the new `+ New binding` flow is regression-locked but list-side filtering is still v0.1 minimum. Operator UX hardening flagged for v0.2 (#37).
- **Orphan credential rows on partial binding-INSERT failure** — `encryptBindingCredentials` writes credentials before the `sources_bindings` INSERT; if the INSERT fails between the two, credential rows commit alone. No plaintext leak (the rows are AES-256-GCM encrypted with AAD-bound credential IDs); cleanup is a manual SQL one-liner. Recommend wrapping `encryptBindingCredentials` + binding INSERT in one `db.transaction` block as a follow-up PR (#37).
- **Provisioning fail-closed: orphan Gitea repos** — when `POST /api/admin/domains` rolls back after Gitea provisioning succeeded, the orphan repo requires manual operator cleanup (a click in their Gitea UI). Acceptable trade-off: operators run Gitea anyway (#37).
- **`setup --bootstrap-domain` deferred** — the Management UI flow (#37) covers domain bootstrap; a CLI scripted-deploy convenience verb is the planned phase-a appendix #3 if pilot feedback demands it.

#### `llm-router` / cost-tracker

- `LlmProviderError.errorClass === 'validation'` should split into transient-vs-validation when adapter-layer retry lands (#8, advisory #3).
- API-key provenance — document `createProvider(name, { apiKey })` as the sanctioned path; env-var fallback is dev-only (#8, advisory #4).
- TDD-hygiene lesson: sequence ESLint rule updates BEFORE the code that needs them (#8, advisory #5).
- Budget-cap concurrent race — two concurrent `generateText()` against a near-cap domain can overshoot by `~N * pre_estimate`. v0.2 hardening via `SELECT FOR UPDATE` on the domain row (#8, advisory #6).
- `debugResponseText: ""` on provider error — consider recording the error message instead, or skipping the debug insert entirely (#8, advisory #7).
- No `LLM_DEBUG_LOG=1` boot banner in router constructor (the main banner lands at engine bootstrap; the admin-API onSend hook covers the request-level banner) (#8, advisory #8).
- `numeric(10,6)` `cost_usd` overflow ceiling — add CHECK constraint `cost_usd >= 0 AND cost_usd < 10000` if NaN/Infinity smuggling surfaces (#8, advisory #9).

#### `credential-store`

- `timingSafeEqual` at AAD compare — defense-in-depth; AAD is non-secret metadata. v0.2 hardening (#7).
- Forbidden-keys scan — consider positive allow-list (`credential_id`, `schema_ref`, `reason`) instead of deny-list (#7).
- `CredentialStoreDb` generic narrowing — tighten to `PgDatabase<...,{credentials: typeof credentials}>` so mis-wired DB handles fail at compile, not runtime (#7).
- Rate-limiting on `read()` — v0.2; UUIDv4 IDs mitigate enumeration for v0.1 (#7).
- `rawRowFor` / `rawIvFor` test-only helpers on `InMemoryCredentialStore` — documented smell; consider `createTestHarness(store)` extraction if a third store impl lands (#7).

#### Source / output adapters

- `source-asana` `reviewMode` enum gap — v0.1 ships incomplete `'auto'|'review'`; full `'auto'|'approve'|'review'` matches `source-fireflies`. Reconciliation is a v0.2 advisory (#30).
- `source-fireflies` partner-traffic alignment — webhook signature header + envelope are forward-looking; PoC ground truth is currently Drive-routed. A small follow-up PR will adjust if Fireflies' actual API differs once partner traffic enables direct webhook (#30).

#### Admin-API

- Audit-log filters (`since`, `actorUserId`, `resourceType`) deferred to v0.2; operators paginate via `limit/offset` for v0.1 (#31).
- Lint-findings `?domainSlug=` filter deferred to v0.2 (#31).
- `admin_audit_log` simplified schema — typed `AuditMetadata` discriminated union constrains shapes; rich rigid columns (`resource_type`/`resource_id`/`before`/`after`) deferred to v0.2 if ops need direct SQL queries by resource (#31).
- PAT-based auth for v0.1; Gitea OAuth deferred to v0.2 (#31).
- PAT storage XSS trade-off — `sessionStorage.opencoo_pat` clears on tab close; v0.2 explores HttpOnly OAuth session cookies. Documented in `packages/ui/README.md` (#32).

#### Phase-a e2e

- `--stub-llm` flag and `opencoo heartbeat run --once` CLI verb were planner-sized but NOT shipped. The engines do not yet have a runnable bin entry or BullMQ-worker bootstrap; building those alongside the e2e harness would balloon PR 32 past budget. The same security invariants are exercised at the function-call layer (`MockLlmClient`, `MockOutputChannelAdapter`); P2 follow-ups for v0.2 alongside the engine bin entry (#35).

#### CLI

- `--skip-migrate` is a v0.1 NO-OP — engines don't auto-migrate at boot; operator runbook is `setup → migrate → doctor` (#33).
- `source test` validates adapter construction only in v0.1; live API smoke deferred to engine-harness re-use (#33).
- `source forget` does NOT rewrite Gitea wiki history — operator notice + Lint catches orphan citations (#33).

### Phase-a EXIT GATE STATUS

`IMPLEMENTATION-PLAN.md` §1.3 enumerates the criteria. Status as of `a780a99`:

- [x] PRD §5 criteria 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 — green in CI (Criteria 11 / 12 are phase-b and phase-c gates respectively).
- [ ] **Pilot cuts over on phase-a code.** At least one pipeline runs on opencoo in parallel with the n8n equivalent; opencoo output quality ≥ n8n baseline on reviewer sign-off. **OPEN — partner cutover is the single most important exit criterion and the gate to tagging.**
- [ ] THREAT-MODEL §5 PR-checklist run on the phase-merge commit — every box ticked or residual risk added to §7. **OPEN — to be run pre-tag.**
- [x] Fresh `docker compose up -d` → operator can create one domain + one binding through the Management UI without psql, exercised by `pnpm test:e2e -- domain-and-binding-create` (appendix #2).
- [ ] `CHANGES-v0.1.md` drafted with breaking-change list from pre-release to `a.N`. **THIS DOCUMENT — pending maintainer edit.**

Two of five exit-gate boxes are open; both require human action (partner sign-off + maintainer-run THREAT-MODEL checklist + edit-and-merge of this document). No additional code work is required to tag `0.1.0-a`.

---

## Phase-a — by-section recap

This section mirrors `IMPLEMENTATION-PLAN.md` §1.2.1 through §1.2.10 for readers who want the architectural narrative rather than the operator-facing one above.

### §1.2.1 Shared foundations (PRs 01–07)

Schema first per `architecture.md` §14.4 (single ownership: `packages/shared/db/schema/*` is the only place `pgTable` lives), then logger / errors / normalize, then the load-bearing shared services. Every later PR depends on this set.

PRs: #1 (§0 pre-coding gate — pnpm/turbo workspace + 4 ESLint boundary rules), #2 (Drizzle core schema), #3 (ingestion-side schema, 9 tables), #4 (self-op schema + the 5th ESLint rule `no-update-append-only`), #5 (logger + errors + `LOG_LEVEL`), #6 (text-normalize), #7 (credential-store with the pg-mem → pglite pivot mid-PR), #8 (llm-router + cost-tracker + budget-cap, **closing the THREAT-MODEL §7 residual**).

After PR 7 the foundation checkpoint held: `pnpm test` at repo root passes with every use-case test in-memory, no Docker, no network. The `MockLLMClient` recording workflow shipped as part of PR 7 keeps the no-network invariant testable.

### §1.2.2 `wikiWrite` and Gitea MCP updates (PRs 08–09)

PR #9 (`wiki-write` — sole sanctioned write path; modes / atomic commits / queue concurrency / delete-cap / cross-domain defense). PR #10 (`gitea-wiki-mcp-server` REPOS config + `worldview://` resources + PAT-scope enforcement at the API layer).

### §1.2.3 Document conversion + guards (PRs 10–12)

PR #11 (`converter-docling`, the first adapter package + `DocumentConverterAdapter` contract suite). PR #13 (`wiki-gitea` adapter + 13-assertion shared contract). PR #14 (`guard-redaction-regex` adapter — first `GuardAdapter` + 14 v1 patterns + 12-assertion contract suite + the metadata-only sentinel test that's the THREAT-MODEL §3.3 lynchpin).

### §1.2.4 Ingestion engine (PRs 13–17)

PR #15 (engine-ingestion scaffold — Fastify boot + BullMQ + readiness probes). PR #16 (intake + dedupe + webhook receiver + sticky `signature_ok` OR-stickify). PR #17 (classifier + XML spotlighting + the foundational injection corpus — sentinel→amp→xmlbody order). PR #18 (compiler — atomic per-run `wikiWrite` + `page_citations` + `Worldview-Impact` git trailer; one classifier run = one wiki commit, ever). PR #19 (5 ingestion pipelines: Scanner / Compilation Worker / Index Rebuilder / Review Dispatcher / Cleanup; `WikiAdapter.listMarkdown` extension; `SourceAdapter` port).

### §1.2.5 Self-Op engine + first-party agents (PRs 18–22)

PR #20 (engine-self-operating scaffold + UI static host + scaffold promotion to shared). PR #21 (agent harness + spotlight promotion + invariant-8 carve-out for `agent_runs` terminalisation). PR #22 (Heartbeat + Lint reader agents + `OutputChannel` / MCP ports + writer-shape ledger probe). PR #23 (Chat agent + automation-drift detector + `callerPat` propagation + scope-domain SQL filter — the cross-tenant leak fix). PR #24 (Surfacer + Builder + the four-layer Gate-3 enforcement — type / schema / runtime / source-grep). PR #25 (worldview compilation pipeline + sovereignty spy + 24KB cap retry + debounce policy).

### §1.2.6 SourceAdapters + `catalog-workflows` (PRs 23–27)

PR #26 (`source-drive` reference SourceAdapter + 9-polling + 3-webhook stubs in the shared contract). PR #27 (`source-asana` webhook-mode + `output-asana` first OutputAdapter + 9-assertion `outputAdapterContract` + webhook stubs → real assertions). PR #28 (`automation-n8n-mcp` AutomationAdapter + vendored `n8n-skills` baseline + cross-package Gate-3 source-grep with token-aware comment stripping). PR #29 (`source-n8n` REST scanner + `catalog-workflow` Compiler template + guard wiring + shared `CONTENT_KINDS` const + lossless round-trip across 3 fixture shapes). PR #30 (`source-fireflies` webhook SourceAdapter — final §1.2.6 PR).

### §1.2.7 Review Dashboard + Management UI + CLI (PRs 28–30)

PR #31 (Review Dashboard server-side admin-API plugin — auth + CSRF + audit-log + sovereignty-token primitives + state-machine guards). PR #32 (Management UI — Vite + React 19 SPA + 4 admin tabs + 5 design-system components + LLM-policy editor + 4 new admin endpoints + version-manifest compile-time guard). PR #33 (`@opencoo/cli` 6 verbs + production composition root — `productionServerFactory` registers admin-API BEFORE static-UI, vanilla-fetch `GiteaClient` with 5s timeout + typed errors + PAT scrub, `SESSION_HMAC_KEY` base64-decode validate, `OPENCOO_ADMIN_PAT_FILE` Docker-secrets, adapter-registry contract in shared).

### §1.2.8 Prompt-injection corpus + phase-a e2e (PRs 31–32)

PR #34 (prompt-injection corpus — 5 universal invariants + 6 per-category checks across 86 fixtures × 9 prompts × 2 locales; generator with byte-determinism; orphan detection; CI ship-blocker `prompt-injection-corpus` deterministic tier; manual-trigger real-LLM workflow). PR #35 (phase-a e2e ship gate — 3 e2e specs (`ingest-to-wiki`, `heartbeat`, `forget`) against compose-spun fixture Gitea + Postgres + Redis covering PRD §5 criteria 2 / 3 / 9; in-memory `SourceAdapter` fixture; deterministic seed; `compose.e2e.yml` + `compose-controller`; separate `vitest.e2e.config.ts` lane; `.github/workflows/release.yml` runs `pnpm test:e2e` on release tags under the 10-minute wall-clock budget; output-side enforcement exercised via the PR 31 attacker-output fixtures (cross-domain-write / path-traversal / unicode-homoglyph)).

### §1.2.9 Phase-a appendix — bootable-locally `opencoo` verb (post-32)

Appendix #1 (#36): bare `opencoo` boot verb + local-dev `compose.yml`. Architecture.md §14.5 specifies bare `opencoo` (no subcommand) as the long-running boot verb; PR 30 shipped six other verbs but not the boot path. This appendix closes the gap so a partner (or maintainer) can `git clone → docker compose up -d → pnpm opencoo` against the merged phase-a code. `runServe` is pure orchestration — dynamic-imports `start({env})` from `engine-self-operating`, registers SIGTERM/SIGINT, memoises shutdown. Local-dev `compose.yml` brings up Postgres + Redis + Gitea on standard host ports (5432 / 6379 / 3000); container names (`opencoo-*`) and ports are deliberately distinct from `compose.e2e.yml` (`opencoo-e2e-*`, 55432 / 56379 / 53000) so both stacks coexist. Partner-deploy compose with `_FILE` Docker-secrets is a phase-c PR.

### §1.2.10 Phase-a appendix #2 — domain + source-binding create flow (post-36)

Appendix #2 (#37) closes the regression PR 29 introduced: architecture.md §13 promised "Sources — list + add" but PR 29 shipped only `+ list`, leaving an operator unable to bind a source through the UI without psql. PRD §5 #1 ("a default domain without manual DB edits") was failing in pilot today as a result. The PR adds the missing `+ add` flow on both Domains and Sources tabs, plus the matching admin-API endpoints (`POST /api/admin/domains` with Gitea repo provisioning, `POST /api/admin/source-bindings` with two-credential webhook split, `GET /api/admin/adapters`), the `defaultReviewModeFor` shared lookup, the `webhook_secret_credentials_id` migration (0007), fail-closed transactional provisioning (orphan Gitea repos are operator-deletable; partial DB rows are not), and the e2e regression test (`domain-and-binding-create.test.ts`) that prevents this from re-breaking. THREAT-MODEL §3.5 was updated in the same commit to document the wikiWrite-bypass exception, and the `no-direct-gitea-write` rule was tightened to allow-list exactly the new helper file. Appendix #3 — `setup --bootstrap-domain` CLI verb — is deferred until pilot feedback demands a scripted-deploy shortcut.

---

## What's NOT in `0.1.0-a` (deferred by design)

Per `IMPLEMENTATION-PLAN.md` §2 and §3:

### Phase-b (tags as `0.1.0-b.N`) — `catalog-skills` + SkillMiner

- `catalog-skills` class + Compiler template
- `source-skill-bundle` adapter
- SkillMiner Pass 1 (Worker Detector) + Pass 2 (Thinker Synthesizer + pre-summarization)
- Review Dashboard 5th item type (skill candidates) with slug-collision Supersede flow
- Miner UI tab + suppressions management
- `redaction_events` audit table + Execution Log integration

The `miner_runs`, `miner_suppressions`, `catalog_candidate`, and `redaction_events` tables ARE present in phase-a (migrations 0001 / 0003) — phase-a sets up the storage; phase-b implements the pipeline.

**Phase-b entry gate** is two consecutive weeks of phase-a stable in pilot production without a severity-1 incident — the two-week soak is the adoption contract.

### Phase-c (tags as `0.1.0-c.N`) — Overlay + marketplace live-fetch polish

- Partner Builder-skill overlay loader + Management UI Create-in-Gitea / Use-existing-URL flow
- Marketplace live-fetch loop against `czlonkowski/n8n-skills` Releases API (weekly polling, SHA verification, `marketplace_updates` row with diff, never auto-activates a new skill version)
- Review Dashboard 4th item type — Marketplace Updates entries with diff + accept/skip

The vendored `n8n-skills` baseline IS present in phase-a (`packages/adapters/automation-n8n-mcp/vendor/n8n-skills/` with placeholder bundles + `n8n-skills.lock.json` recording `{tag, sha, fetchedAt}`) — phase-a establishes the offline-bundle loader; phase-c adds the live-fetch loop and partner overlay.

`0.1.0` rolls up `a` + `b` + `c` once stable at ≥ 1 partner.

---

_Drafted from `IMPLEMENTATION-PLAN.md` §1.2.1–§1.2.10 + per-PR `gh pr view` body residuals. Maintainer to edit before the `0.1.0-a` tag cut._

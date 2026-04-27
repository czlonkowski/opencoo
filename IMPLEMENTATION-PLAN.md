# opencoo v0.1 — Implementation Plan

> Phased, gated, dependency-ordered delivery plan for the implementing Claude Code team.
> Every deliverable has a **test written first** (TDD), a **verify command**, and an **exit criterion**.
> No deliverable advances past its gate until the gate is green.
>
> Read first: `PRD.md` (what + why), `CONVENTIONS.md` (TDD/TS/testing discipline), `docs/ARCHITECTURE.md` (contributor-facing shapes) / `architecture.md` (internal design-of-record; local, gitignored), `THREAT-MODEL.md` (security checklist per subsystem).

---

## Progress snapshot (as of 2026-04-26)

**Phase-a: 32 / 32 PRs merged — phase-a complete** (plus the §0 pre-coding gate). `main` is at commit `f7eba78`; full repo 1588 passed | 2 skipped + 88 prompt-injection deterministic-tier passed | 11 skipped (separate `pnpm test:injection` lane), and the new `pnpm test:e2e` lane (3 e2e specs against compose-spun Gitea + Postgres + Redis) green on the release-tag CI job. Docker installed via colima for the wiki-gitea contract suite and the e2e compose stack.

| # | IMPL PR | GitHub PR | Merge commit | Title | THREAT-MODEL coverage |
|---|---|---|---|---|---|
| 1 | §0 gate | #1 | `c436d56` | pnpm/turbo workspace + 4 ESLint boundary rules | invariants 2 / 5 / 9 / 10 |
| 2 | PR 01 | #2 | `6fe1f99` | Drizzle core schema (domains / sources_bindings / users / credentials) | §3.6 shape |
| 3 | PR 02 | #3 | `ec7881e` | Ingestion schema (9 tables) + append-only invariant + `catalog_candidate` carve-out in §2-8 | invariant 8 |
| 4 | PR 03 | #4 | `4e4aa5f` | Self-op schema + `agent_runs` FK backfill + 5th ESLint rule `no-update-append-only` | invariant 7 (Gate 3 JSDoc), invariant 8 |
| 5 | PR 04 | #5 | `16de035` | Logger + errors taxonomy + `LOG_LEVEL` allow-list | invariant 11 (doc + callout) |
| 6 | PR 05 | #6 | `173573b` | text-normalize (NFC + control-strip + fence-aware collapse) | §6.3 converter-edge normalisation |
| 7 | PR 06 | #7 | `71014d1` | credential-store (AES-256-GCM, AAD-bound, KMS-swappable) | §3.6 full |
| 8 | PR 07 | #8 | `7be9252` | llm-router + cost-tracker + budget-cap + `llm_usage_debug` migration | invariants 5, 11; **§7 residual "no hard LLM spend cap" CLOSED** |
| 9 | PR 08 | #9 | `33fbcf0` | wiki-write (sole sanctioned write path) + `WikiAdapter` port | invariant 2, §3.5 |
| 10 | PR 09 | #10 | `184d0f5` | `gitea-wiki-mcp-server` REPOS config + `worldview://` resource + PAT-scope enforcement | §3.14 full |
| 11 | PR 10 | #11 | `d0e957b` | converter-docling + `DocumentConverterAdapter` contract suite (first adapter package) | §3.2 full |
| 12 | PR 11 | #13 | `47f7e52` | `wiki-gitea` Gitea-backed WikiAdapter + shared 13-assertion contract suite | §3.5 full, path-traversal defense |
| 13 | PR 12 | #14 | `fff6a19` | `guard-redaction-regex` GuardAdapter port + 14-pattern v1 catalog | §3.7 redaction shape |
| 14 | PR 13 | #15 | `e4036fe` | `engine-ingestion` scaffold + Fastify boot + BullMQ wiring + readiness probes | §3.0 process-shape |
| 15 | PR 14 | #16 | `03711c1` | intake + dedupe + webhook receiver + sticky `signature_ok` OR-stickify | §3.1 webhook-mode |
| 16 | PR 15 | #17 | `2b14f97` | classifier + XML spotlighting + injection corpus (sentinel→amp→xmlbody order) | §3.4 full |
| 17 | PR 16 | #18 | `8c1c850` | compiler — atomic per-run `wikiWrite` + `page_citations` + `Worldview-Impact` trailer | invariant 2 |
| 18 | PR 17 | #19 | `11aecf7` | 5 ingestion pipelines + `WikiAdapter.listMarkdown` + `SourceAdapter` port | §3.0 pipeline-shape |
| 19 | PR 18 | #20 | `4039438` | `engine-self-operating` scaffold + UI host + scaffold promotion to shared | §3.8 process-shape |
| 20 | PR 19 | #21 | `d8f3bf9` | agent harness + spotlight promotion + invariant-8 carve-out (agent_runs terminalisation) | §3.5 memory poisoning, invariant 8 |
| 21 | PR 20A | #22 | `4fc1150` | Heartbeat + Lint reader agents + OutputChannel/MCP ports + writer-shape ledger probe | §3.5 reader-only |
| 22 | PR 20B | #23 | `68aa79e` | Chat agent + automation_drift detector + `callerPat` propagation + scope-domain SQL filter | §3.5 cross-tenant SQL leak fix |
| 23 | PR 21 | #24 | `b522215` | Surfacer + Builder + 3 gates (gate 3 type-level: `AutomationAdapter.deployWorkflow` only) | invariant 7 full (Gate 3 type + grep + schema + runtime) |
| 24 | PR 22 | #25 | `ffa4161` | Worldview compilation pipeline + sovereignty spy + 24KB cap retry + debounce policy | §3.4 worldview, §3.5 wikiWrite, §3.7 sovereignty |
| 25 | PR 23 | #26 | `63076a7` | `source-drive` reference SourceAdapter + shared `sourceAdapterContract` suite (9 polling + 3 webhook stubs) | §3.1 SourceAdapter, §3.6 invariant 11 (`@ts-expect-error` pin) |
| 26 | PR 24 | #27 | `f02c964` | `source-asana` (webhook-mode) + `output-asana` (first OutputAdapter) + 9-assertion `outputAdapterContract` suite + webhook stubs → real assertions | §3.1 webhook-mode, §3.6 invariant 11, no-raw-credentials-in-result pin |
| 27 | PR 25 | #28 | `db59500` | `automation-n8n-mcp` AutomationAdapter + vendored `n8n-skills` baseline + Gate-3 cross-package source-grep + token-aware comment stripping | §2 invariant 7 (Gate 3 four layers), §3.9 automation-loop, §3.6 invariant 11 |
| 28 | PR 26 | #29 | `8c09365` | `source-n8n` REST scanner + `catalog-workflow` Compiler template + guard wiring + shared `CONTENT_KINDS` const + lossless round-trip across 3 fixture shapes | §3.4 fenced-block parser, §3.6 invariant 11, §3.7 unconditional guard wiring |
| 29 | PR 27 | #30 | `353426d` | `source-fireflies` webhook SourceAdapter (HMAC + replay-stable eventId + non-empty title + collision guard + original-body contentBytes + allowlist filter) | §3.1 webhook-mode, §3.6 invariant 11, §3.7 review_mode default `'approve'` |
| 30 | PR 28 | #31 | `3aa9b56` | Review Dashboard server-side admin-API plugin (auth + CSRF + audit-log + sovereignty-diff token primitives + state-machine guards) | §2 invariant 8 (admin_audit_log append-only), §3.13 admin authz |
| 31 | PR 29 | #32 | `044f261` | Management UI (Vite+React 19 SPA, 4 admin tabs, 5 design-system components + Glyph trio) + LLM-policy editor + 4 new admin endpoints (`domains`, `domains-llm-policy` preview/apply with `confirmDiff: true`, `prompts`, `logout`) + version-manifest compile-time guard | §3.13 admin authz, §3.0 process-shape, sovereignty-diff editor with replay protection |
| 32 | PR 30 | #33 | `bc1f193` | `@opencoo/cli` (6 verbs: migrate / setup / doctor / source test / source forget / recompile) + production composition root (server-factory admin-API BEFORE static-UI; vanilla-fetch GiteaClient with 5s timeout + typed errors + PAT scrub; SESSION_HMAC_KEY base64-decode validate; OPENCOO_ADMIN_PAT_FILE Docker-secrets) + adapter-registry contract in shared | §3.13 admin authz, §3.15 internet-facing surfaces, §3.6 invariant 11 (PAT never in errors / no credential values printed) |
| 33 | PR 31 | #34 | `a215eb1` | Prompt-injection corpus (5 universal invariants + 6 per-category checks across 86 fixtures × 9 prompts × 2 locales) + generator with byte-determinism + orphan detection + CI ship-blocker job (`prompt-injection-corpus` deterministic tier) + manual-trigger real-LLM workflow | §4.2 prompt injection (phase-a ship-blocker), §3.4 spotlighting verified at every prompt's assembly |
| 34 | PR 32 | #35 | `f7eba78` | Phase-a e2e ship gate: 3 e2e specs (`ingest-to-wiki`, `heartbeat`, `forget`) against compose-spun fixture Gitea + Postgres + Redis covering PRD §5 criteria 2 / 3 / 9; in-memory `SourceAdapter` fixture; deterministic seed; `compose.e2e.yml` + `compose-controller`; `vitest.e2e.config.ts` separate lane; `.github/workflows/release.yml` runs `pnpm test:e2e` on release tags under the <10 min wall-clock budget; output-side enforcement exercised via PR 31 attacker-output fixtures (cross-domain-write / path-traversal / unicode-homoglyph) | §3.0 e2e harness, §3.5 output-side path-traversal at the wikiWrite boundary, §4.2 attacker-output replay |

**What's complete structurally:**
- §1.2.1 Shared foundations — **COMPLETE** (7 of 7 PRs).
- §1.2.2 wiki-write + MCP — **COMPLETE** (2 of 2 PRs).
- §1.2.3 Document conversion + guards — **COMPLETE** (3 of 3 PRs: PRs 10 / 11 / 12).
- §1.2.4 Engine-ingestion — **COMPLETE** (5 of 5 PRs: PRs 13–17).
- §1.2.5 Engine-self-operating + agents + worldview — **COMPLETE** (5 of 5 PRs: PRs 18, 19, 20, 21, 22).
- §1.2.6 SourceAdapters + `catalog-workflows` — **COMPLETE** (5 of 5 PRs: PRs 23 / 24 / 25 / 26 / 27).
- §1.2.7 Review Dashboard + Management UI + CLI — **COMPLETE** (3 of 3 PRs: PRs 28 / 29 / 30).
- §1.2.8 Prompt-injection corpus + phase-a e2e — **COMPLETE** (2 of 2 PRs: PRs 31 / 32 — phase-a ship gate green).

**Team workflow in use:** per-PR team cycle via the `opencoo-phase-a` agent team — planner drafts plan, orchestrator approves, implementer executes TDD, simplifier refines, reviewer gates (with explicit `/security-review` on THREAT-MODEL-touching PRs). GitHub Copilot auto-review triaged before every merge. Squash-merge to main after CI green. Each PR's closed GitHub branch preserves the full TDD-ordered commit history for bisect.

**Residual advisories filed across PRs 7-31** (all non-blocking, v0.2 hardening or future-PR reactivity): listed in each PR's body on GitHub. Tracked for the phase-a exit-gate `CHANGES-v0.1.md` draft.

**Next**: phase-a is feature-complete. Two appendix PRs landed AFTER the §1.2.1–§1.2.8 set: §1.2.9 (bare `opencoo` boot verb + local-dev `compose.yml`) makes the system bootable end-to-end; §1.2.10 (domain + source-binding create flow) closes the regression PR 29 introduced — `+ New domain` / `+ New binding` modals on the Management UI now create both primitives end-to-end without operators touching psql. The §1.3 phase-a exit gate is the active checklist — PRD §5 criteria 1–10 verification, pilot cutover sign-off, THREAT-MODEL §5 PR-checklist run on the phase-merge commit, and the `CHANGES-v0.1.md` draft. Once those land, `0.1.0-a` is ready to tag (maintainer call) and phase-b entry-gate work (§2.1) can begin.

---

## 0. Pre-coding gate (before Phase a starts)

**Gate condition:** the design-partner PoC is end-to-end production-stable (CLAUDE.md "No opencoo TypeScript is written until the PoC is end-to-end production-stable").

**Exit criteria (all must hold before opening the first TypeScript PR):**

- [x] Pilot PoC runs every pipeline in production for ≥ two consecutive weeks without manual intervention beyond normal operator triage.
- [x] Pilot prompts are frozen and tagged. Committed to `packages/shared/prompts/pl/` staging branch (gitignored until phase-a PR 01 lands).
- [x] `architecture.md` refinement PR merged, capturing every PoC-discovered edge case, prompt revision, and flow that didn't survive contact with production.
- [x] `docs/local/` is authoritative for "what runs today"; no conflict between PoC operational truth and the OSS spec.
- [x] `DECISIONS.md` is empty (zero open items) or every open item is explicitly deferred with an owner.
- [x] Repo has `pnpm` + `turbo` + Drizzle + vitest toolchain bootstrapped (repo-root `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`). (PR #1, commit `c436d56`)
- [x] **`eslint.config.js` present at repo root with four custom boundary rules enforced.** Each rule ships with a negative-case fixture that would lint-pass without the rule and lint-fail with it — proving the rule is doing what it says (the rules are load-bearing for the rest of the plan; they must exist before PR 01 opens). _(PR #1; 5th rule `no-update-append-only` added in PR #4 once the invariant-8 table set stabilised.)_
  - `no-cross-engine-import` — `packages/engine-ingestion/**` cannot import from `packages/engine-self-operating/**` and vice versa (`architecture.md` §2.5; THREAT-MODEL §2 invariant 10).
  - `no-direct-gitea-write` — non-provisioning code cannot import the Gitea API client directly; must go through `packages/shared/wiki-write` (THREAT-MODEL §2 invariant 2).
  - `no-direct-llm-sdk` — `@ai-sdk/*` / Vercel AI SDK imports are forbidden outside `packages/shared/llm-router` (THREAT-MODEL §2 invariant 5).
  - `no-feature-env-vars` — `process.env.*` outside the allow-list (`DATABASE_URL`, `ENCRYPTION_KEY`, `PORT`, `ADMIN_BOOTSTRAP_TOKEN` + their `_FILE` variants, plus `NODE_ENV`, `LLM_DEBUG_LOG`, `LOG_LEVEL`, `TELEMETRY_ENDPOINT`) is a lint error (THREAT-MODEL §2 invariant 9). _(`LOG_LEVEL` added in PR #5.)_
- [x] `pnpm lint` green on the empty repo. `pnpm lint` on each negative-case fixture file fails with the expected rule ID.

---

## 1. Phase a — Pilot cutover parity + `catalog-workflows`

Ships as `0.1.0-a.N` tags. **Gates the pilot migration.** Nothing activates in the partner's environment until phase-a exits green. (CLAUDE.md "v0.1 ship sequence", §17 Resolved "Pilot migration path")

### 1.1 Entry gate

- [x] All §0 exit criteria green.
- [x] CI is able to run `pnpm test` on an empty repo (vitest configured, one trivial passing test). This proves the harness before any real test lands. _(Verified on PR #1 merge.)_

### 1.2 Deliverables (dependency-ordered)

Each deliverable is a PR-sized unit. Larger items (Review Dashboard, engines) are explicitly split into sub-deliverables. Every PR follows the TDD Red → Verify Red → Green → Verify Green → Refactor cycle from `CONVENTIONS.md`.

> **How to read this table.** *Test-first artifact* = the failing test written before any production code. *Acceptance* = what must be true at merge. *Verify* = the exact command that proves it. *Files* = a rough budget — PRs that blow through this by 2× need a reviewer heads-up, not a rule-break.

#### 1.2.1 Shared foundations (PRs 01–07)

Schema first (per CLAUDE.md + `architecture.md` §14.4 "schema-ownership rule"), then logger/errors/normalize, then the load-bearing shared services. These are pre-requisites for every later PR.

| PR | Title | Depends on | Test-first artifact | Acceptance | Verify | Files est. |
|---|---|---|---|---|---|---|
| 01 ✅ `6fe1f99` (#2) | Drizzle schema: domains + sources_bindings + users + credentials | — | `schema.test.ts` — `pgTable` shapes match § mappings; `drizzle-kit generate` produces SQL that applies cleanly on empty Postgres; migrations are **idempotent** (a second apply on the same schema produces zero changes); `domains` carries `class ∈ {'knowledge', 'catalog-workflows', 'catalog-skills'}`, nullable `llm_budget_monthly_cap_usd numeric(10,2)`, `governance_cadence`, `review_role`, `locale` | Schema compiles; `pnpm --filter shared db:generate` emits deterministic SQL; running generator twice produces identical output; RLS not required in v0.1 | `pnpm --filter shared test` + `pnpm --filter shared db:check` + `pnpm --filter shared db:generate --check` (byte-equal on second run) | ~10 |
| 02 ✅ `ec7881e` (#3) | Drizzle schema: ingestion-side tables | PR 01 | `schema-ingestion.test.ts` — every `ingestion_intake`, `webhook_events`, `page_citations`, `llm_usage`, `miner_runs`, `catalog_candidate`, `miner_suppressions`, `redaction_events`, `erasure_log` table present and append-only-shaped (no `updated_at`) | Migrations apply; append-only invariant encoded via types | Same as PR 01 | ~10 |
| 03 ✅ `4e4aa5f` (#4) | Drizzle schema: self-op tables + marketplace_updates | PR 01 | `schema-selfop.test.ts` — `agent_definitions`, `agent_instances`, `agent_runs` (jsonb `skills_used`), `automation_candidates`, `automation_deployments`, `marketplace_updates` | Migrations apply; `agent_runs.skills_used` is `jsonb` with Zod type | Same as PR 01 | ~8 |
| 04 ✅ `16de035` (#5) | `packages/shared/logger` + `errors` | PR 01 | `logger.test.ts` — emits JSON-per-line with `ts`/`level`/`module`/`run_id`; never multi-line; no raw prompts at `info` level (THREAT-MODEL §2 invariant 11) | One `Logger` interface exported; `ErrorClass` union (Transient / Upstream-quota / Validation) typed | `pnpm --filter shared test logger` | ~6 |
| 05 ✅ `173573b` (#6) | `packages/shared/text-normalize` | — | `text-normalize.test.ts` — NFC + control-strip + whitespace-collapse; idempotent on pre-normalized input; preserves code fences | Exported `normalize(input: string): string`; used at router edge (unit only here) | `pnpm --filter shared test text-normalize` | ~4 |
| 06 ✅ `71014d1` (#7) | `packages/shared/credential-store` (AES-256-GCM impl behind interface) | PR 01 | `credential-store.test.ts` — round-trip encrypt/decrypt; AAD binds to credential ID; IV never reused across writes; rejects keys < 32 bytes; reads tolerate old `encryption_version`; writes always current; never logs plaintext | Interface exported so KMS backend plugs in later without schema change (§17 Resolved "Credentials vault") | `pnpm --filter shared test credential-store` | ~8 |
| 07 ✅ `7be9252` (#8) | `packages/shared/llm-router` + `cost-tracker` + per-domain spend cap | PRs 01, 03, 04 | `llm-router.test.ts` — every call goes through router; per-domain `llm_policy` enforced; `LlmPolicyViolationError` typed; no silent fallback; `llm_usage` row written with tier/model/pipeline/doc_id/tokens/cost/latency; full prompt/response only in `llm_usage_debug` when `LLM_DEBUG_LOG=1`. **Spend-cap enforcement:** when the domain's month-to-date `llm_usage.cost` sum breaches `llm_budget_monthly_cap_usd` (nullable; null = unlimited), router **pauses the domain's BullMQ queues** and throws `LlmBudgetExceededError`; admin alert emitted; fail-closed (THREAT-MODEL §7 risk "No hard LLM spend cap" — resolved in phase a) | No provider SDK instantiation outside router; lazy imports per provider; queue-pause is idempotent; re-enable requires admin action in UI (wired in PR 29) | `pnpm --filter shared test llm-router` + `pnpm --filter shared test cost-tracker` + `pnpm --filter shared test budget-cap` | ~14 |

**Phase-a foundations checkpoint:** after PR 07, run `pnpm test` at repo root — every use-case test written so far passes in-memory, no Docker touched, **no network calls** (every `MockLLMClient` fixture is pre-recorded and offline-playable; recording workflow documented in `packages/shared/testing/record-llm.ts` shipped as part of PR 07). If any test needs Docker or network to pass, a fixture is missing; fix before moving on. (`architecture.md` §14.3; `CONVENTIONS.md` §3.1)

#### 1.2.2 `wikiWrite` and Gitea MCP updates (PRs 08–09)

| PR | Title | Depends on | Test-first artifact | Acceptance | Verify | Files est. |
|---|---|---|---|---|---|---|
| 08 ✅ `33fbcf0` (#9) | `packages/shared/wiki-write` | PRs 01, 04, 07 | `wiki-write.test.ts` — modes `'replace' \| 'append' \| 'delete'`; one call = one atomic Gitea commit; stale-SHA pull-retry; per-domain BullMQ queue `concurrency: 1`; delete-mode daily cap (default 10) fails closed above threshold; commit-message tags `[compiler]` / `[lint]` / etc. required; forbids cross-domain paths even if caller mis-validates (belt-and-suspenders per THREAT-MODEL §3.5) | `InMemoryWikiAdapter` in `__fixtures__/` for use-case tests; real `wiki-gitea` adapter tested separately in PR 11 | `pnpm --filter shared test wiki-write` | ~10 |
| 09 ✅ `184d0f5` (#10) | `gitea-wiki-mcp-server` — REPOS config + `worldview://` resource | PR 08 | `mcp-worldview-resource.test.ts` — `worldview://{domain}` and `worldview://company` resolvable; PAT-scope enforced at API layer; out-of-scope reads return uniform "not accessible" (THREAT-MODEL §3.14) | No wiki content cached across PAT changes | `pnpm --filter gitea-wiki-mcp-server test` | ~6 |

#### 1.2.3 Document conversion + guards (PRs 10–12)

| PR | Title | Depends on | Test-first artifact | Acceptance | Verify | Files est. |
|---|---|---|---|---|---|---|
| 10 ✅ `d0e957b` (#11) | `packages/adapters/converter-docling` | PR 05 | `converter-docling.contract.test.ts` — pass shared `DocumentConverterAdapter` contract suite: fails-closed on malformed input (`ConversionError`), triggers `extraction_degraded` when a known-tabular input produces zero GFM pipes, strips script/style/iframe, does not follow external refs | Sidecar process contract documented; `network_mode: none` recommended | `pnpm --filter converter-docling test` | ~8 |
| 11 | `packages/adapters/wiki-gitea` | PR 08 | `wiki-gitea.contract.test.ts` — implements `WikiAdapter` against real Gitea in CI (service-containers); service-account git author on machine commits; `Co-authored-by:` on human-approved | Queue-per-domain respected | `pnpm --filter wiki-gitea test:contract` | ~8 |
| 12 | `packages/adapters/guard-redaction-regex` | PR 02, 04 | `guard-redaction.contract.test.ts` — role=`redaction`; returns `transformed_text`; writes `redaction_events` (metadata only — THREAT-MODEL §3.3 "Do not log matched content"); versioned default pattern list; stateless per `classify()` | `role` + `categories` declared in export; `fail_mode: 'transform'` default | `pnpm --filter guard-redaction-regex test` | ~6 |

#### 1.2.4 Ingestion engine (PRs 13–17)

| PR | Title | Depends on | Test-first artifact | Acceptance | Verify | Files est. |
|---|---|---|---|---|---|---|
| 13 | `engine-ingestion` scaffold: Fastify boot + BullMQ wiring + pipeline loader | PRs 04, 07 | `engine-boot.test.ts` — `opencoo ingestion` starts; `/health` returns 200; `/ready` gates on Postgres + Redis + Gitea; ESLint rule `no-cross-engine-import` green | Process can start with zero pipelines configured; queue names registered deterministically | `pnpm --filter engine-ingestion test` + `pnpm --filter engine-ingestion lint` | ~10 |
| 14 | Intake + dedupe + webhook receiver | PR 13 | `intake.test.ts` — four-level idempotency keys work; HMAC-missing → `ValidationError` → immediate DLQ (no retry per `architecture.md` §6.5); `ErrorClass` taxonomy drives retry policy | Webhook signature verification is per-adapter; receiver is transport only | `pnpm --filter engine-ingestion test intake` | ~8 |
| 15 | Classifier + XML spotlighting | PRs 07, 13 | `classifier.test.ts` — every LLM call wraps untrusted content in `<source_content>`; Zod validation on structured output; path allow-list rejection → silent DLQ (no retry loop, no "try again"); `allowed_paths: ["**"]` fails at runtime (THREAT-MODEL §3.4) | Injection fixture set present and passing (at least 5 fixture files for `en` and `pl`) | `pnpm --filter engine-ingestion test classifier` + `pnpm test:injection` | ~10 |
| 16 | Compiler — atomic per-run writes + page_citations | PRs 08, 15 | `compiler.test.ts` — one classifier run = one `wikiWrite` call = one Gitea commit; frontmatter provenance (`schema_version`, `prompt_version`, `compiled_at`, `compiled_by_run_id`) populated on every page; `Worldview-Impact` git trailer set; `page_citations` rows inserted on every page write | Never calls `wikiWrite` twice per run | `pnpm --filter engine-ingestion test compiler` | ~12 |
| 17 | Scanner + Index Rebuilder + Review Dispatcher + Cleanup | PRs 13–16 | `pipelines.test.ts` — Scanner schedules every 4h, Index every 6h, Cleanup weekly; Cleanup never touches compiled wiki pages or append-only tables (except TTL of `llm_usage_debug`); `retention_days` respected per-domain | All five pipelines boot; BullMQ job counts observable | `pnpm --filter engine-ingestion test pipelines` | ~12 |

#### 1.2.5 Self-Op engine + first-party agents (PRs 18–22)

| PR | Title | Depends on | Test-first artifact | Acceptance | Verify | Files est. |
|---|---|---|---|---|---|---|
| 18 | `engine-self-operating` scaffold + UI static host | PRs 04, 07 | `selfop-boot.test.ts` — `opencoo self-operating` starts; serves bundled UI from Fastify; no cross-engine import | One process, one port; UI static asset route test | `pnpm --filter engine-self-operating test` + `pnpm --filter engine-self-operating lint` | ~10 |
| 19 | Agent harness: `AgentDefinition` + `agent_runs` + memory | PRs 03, 18 | `harness.test.ts` — harness enforces `budget` as hard cap (not advisory); writes `agent_runs` row per invocation including `skills_used`; loads N previous runs per `memory.count`; tools resolved at definition time (no runtime registry); destructive-MCP-tool deny-list (THREAT-MODEL §3.8); memory-poisoning protection (external content in memory is spotlit) | Instance-scope memory default; `agent_instances` wired | `pnpm --filter engine-self-operating test harness` | ~12 |
| 20 | Heartbeat + Lint + Chat (reader agents) | PRs 09, 16, 19 | `agents-readers.test.ts` — none call `wikiWrite`; Chat scoped by caller PAT; Heartbeat grounds on own + company worldview; Lint detects contradictions + stale pages + orphans + `allowed_paths: ["**"]` bindings + prompt-version drift + automation drift (THREAT-MODEL §3.9) | Per-instance output-channel binding (ceo-heartbeat can't write to ops channel) | `pnpm --filter engine-self-operating test agents-readers` | ~14 |
| 21 | Surfacer + Builder (automation loop, gates 1/2/3) | PRs 19, 25 | `automation-loop.test.ts` — Surfacer writes `automation_candidates` with `status: 'proposed'`; never self-approves (gate 1); Builder only on `status: 'approved'`; deploys **disabled**; never calls the `activate` API (gate 3 non-configurable — THREAT-MODEL §2 invariant 7); writes wiki backlinks on source pages | `skills_used` populated with `{slug, version, sha, source}` for every Builder run | `pnpm --filter engine-self-operating test automation-loop` | ~14 |
| 22 | Worldview compilation pipeline | PRs 16, 18 | `worldview.test.ts` — per-domain `worldview.md` stays ≤ 6000 tokens; `Worldview-Impact` trailer triggers refresh with debounce (15m/3h/24h/never-solo); company worldview compiles from per-domain worldviews (not underlying pages) respecting source-domain LLM policy; synthetic high-impact events from Lint contradictions | MCP resources `worldview://{domain}` + `worldview://company` live | `pnpm --filter engine-self-operating test worldview` | ~12 |

#### 1.2.6 SourceAdapters + `catalog-workflows` (PRs 23–27)

| PR | Title | Depends on | Test-first artifact | Acceptance | Verify | Files est. |
|---|---|---|---|---|---|---|
| 23 | `source-drive` (reference SourceAdapter) | PRs 10, 14 | `source-drive.contract.test.ts` — passes shared SourceAdapter contract suite (HMAC tests, `max-bytes` ceiling, no-raw-credentials-in-payloads lint, dedupe on replayed `event_id`); default `content_kind: 'document'` | `credentialSchema` with `x-credential-field: { secret: true }` on every secret; credentials by vault ID | `pnpm --filter source-drive test:contract` | ~10 |
| 24 | `source-asana` + `output-asana` | PR 23 | `source-asana.contract.test.ts`, `output-asana.contract.test.ts` | Shared contract suites pass; rate-limit respected | Same pattern | ~12 |
| 25 | `automation-n8n-mcp` + vendored `n8n-skills` pin | PRs 19, 21 | `automation-n8n-mcp.test.ts` — exports `{ tools, builderSkills, credentialSchema }`; vendored `czlonkowski/n8n-skills` release pinned at build time (by tag + SHA); one active adapter per deployment (§17 Resolved "Builder polymorphism") | n8n API credentials never appear in `agent_runs.tool_calls[].result` | `pnpm --filter automation-n8n-mcp test` | ~12 |
| 26 | `source-n8n` (scans n8n via REST) + `catalog-workflows` Compiler template | PRs 16, 25 | `source-n8n.contract.test.ts`, `compiler-catalog-workflow.test.ts` — `content_kind: 'n8n-workflow'` bypasses DocumentConverter (§6.3.1); Compiler template is "frontmatter merge only"; **losslessness assertion: for every fixture workflow, the round-trip `originalJson → SourceEvent → Compiler → fenced-block body in compiled page → re-parsed JSON` is deep-equal to `originalJson` (ignoring only the top-level `updatedAt` timestamp); lossy recompilation fails the suite**; default tag filter `catalog` | Nightly cadence; redaction guard runs on payloads (`content_kind ≠ 'document'`); at least 3 fixture workflows in the suite covering simple linear, branched-with-IF, and loop-with-SplitInBatches shapes | `pnpm --filter source-n8n test:contract` | ~12 |
| 27 | `source-fireflies` (webhook-mode only, v0.1) | PR 23 | `source-fireflies.contract.test.ts` — **webhook-mode is the v0.1 scope**; HMAC required; `review_mode: 'approve'` default on transcription bindings (THREAT-MODEL §3.1); **transcripts dropped into Drive are covered by `source-drive`, not a separate Fireflies poller** (`architecture.md` §17 Open questions "Fireflies webhook vs Drive polling" — webhook adapter ships first; polling deferred until customer demand) | Dedup on `meeting_id + revision`; no polling mode in v0.1 | `pnpm --filter source-fireflies test:contract` | ~8 |

#### 1.2.7 Review Dashboard + Management UI (PRs 28–30)

| PR | Title | Depends on | Test-first artifact | Acceptance | Verify | Files est. |
|---|---|---|---|---|---|---|
| 28 | Review Dashboard — item types 1–4 (source-binding, Lint, Surfacer, marketplace — §7.3) | PRs 18, 20, 21 | `review-dashboard.test.ts` — server-side Gitea-team membership recheck on every state-changing endpoint; CSRF tokens; `SameSite=Strict`; audit log row per admin action; sovereignty-diff confirmation on `llm_policy` edits (THREAT-MODEL §3.13); visible `LLM_DEBUG_LOG=1` banner | UI filtering is not authorization | `pnpm --filter engine-self-operating test review-dashboard` | ~16 |
| 29 | Management UI: domains / sources / LLM policy / prompts tabs | PR 28 | `management-ui.test.ts` (Playwright-tier; run locally/CI as e2e) — credential-schema form rendering respects `x-credential-field: { secret: true }`; prompt-override diff banner on new defaults | `next-intl` (or equivalent) scaffolding wired; `en.json` populated, `pl.json` placeholder (§17 Resolved "Management UI i18n") | `pnpm --filter ui test:e2e` | ~20 |
| 30 | CLI: `opencoo migrate` / `setup` / `doctor` / `source test` / `source forget` / `recompile` | PRs 06, 08, 17 | `cli.test.ts` — each subcommand parses; `--dry-run` required on non-interactive `source forget`; `doctor` enumerates internet-facing surfaces (THREAT-MODEL §3.15); never prints credential values | Migration opt-out via `--skip-migrate` on long-running procs | `pnpm --filter cli test` | ~14 |

#### 1.2.8 Prompt-injection corpus + phase-a e2e (PRs 31–32)

| PR | Title | Depends on | Test-first artifact | Acceptance | Verify | Files est. |
|---|---|---|---|---|---|---|
| 31 | Prompt-injection corpus at `packages/shared/prompts/__fixtures__/injection/` | All prompt-loading PRs | Fixtures-as-tests: every prompt under `packages/shared/prompts/{locale}/` has matching fixture set covering direct-injection, indirect-via-quoted-content, cross-domain-write, path-traversal, unicode-homoglyph, data-exfiltration (THREAT-MODEL §4.2) | CI job `pnpm test:injection` **fails** when a prompt change regresses a fixture; this is the phase-a ship-blocker | `pnpm test:injection` | ~fixtures per agent/locale |
| 32 ✅ `f7eba78` (#35) | Phase-a e2e: ingest-to-wiki + Heartbeat + forget | PRs 17, 20, 22, 30 | Three e2e tests from PRD §5 criteria 2, 3, 9 — run against a compose-spun fixture Gitea + Postgres + Redis | Runs on release tags; < 10 minutes wall-clock | `pnpm test:e2e` | ~6 |

#### 1.2.9 Phase-a appendix — bootable-locally `opencoo` verb (post-32)

Small, reviewer-flagged scope-stretch landed AFTER the §1.2.1–§1.2.8 set so a partner (or maintainer) can `git clone → docker compose up -d → pnpm opencoo` against the merged phase-a code. Architecture.md §14.5 already specifies bare `opencoo` (no subcommand) as the long-running boot verb; PR 30 shipped six other verbs but not the boot path. This row closes that gap.

| PR | Title | Depends on | Test-first artifact | Acceptance | Verify | Files est. |
|---|---|---|---|---|---|---|
| appendix ✅ `a90f0f9` (#36) | Bare `opencoo` boot verb + local-dev `compose.yml` | PR 30 (CLI), PR 18 (engine-self-operating `start({env})`) | `cli.test.ts` runServe cases — SIGTERM wires `engine.close()` + `exit(0)`; idempotent on repeated SIGTERM; surfaces start failures via `exitRuntimeError(2)` | `runServe` is pure orchestration — dynamic-imports `start({env})` from `@opencoo/engine-self-operating`, registers SIGTERM/SIGINT, memoises shutdown; `compose.yml` brings up postgres + redis + gitea on standard host ports for local dev (partner-deploy compose with `_FILE` secrets is a phase-c PR) | `pnpm --filter @opencoo/cli test` + manual `pnpm opencoo` smoke against the compose stack | ~9 |

#### 1.2.10 Phase-a appendix #2 — domain + source-binding create flow (post-36)

Closes the regression PR 29 introduced: architecture.md §13 promised "Sources — list + add" but the merged Management UI shipped only `+ list`, leaving an operator unable to bind a source through the UI without psql. PRD §5 #1 ("a default domain without manual DB edits") was failing in pilot today as a result. This row adds the missing `+ add` flow on both the Domains and Sources tabs, plus the matching admin-API endpoints, the provisioning helper, and the e2e test that prevents regression.

| PR | Title | Depends on | Test-first artifact | Acceptance | Verify | Files est. |
|---|---|---|---|---|---|---|
| appendix #2 | Domain create + binding create flow | PRs 28/29 (admin-API, UI), PR 30 (composition root), PR 36 (boot verb) | `domains-create.test.ts` (9 assertions), `source-bindings-create.test.ts` (12 assertions), `gitea-provisioning.test.ts` (7 assertions), `adapters-list.test.ts` (6), UI modal tests (11), route-button tests (6), e2e `domain-and-binding-create.test.ts` (3) | `POST /api/admin/domains` + `POST /api/admin/source-bindings` + `GET /api/admin/adapters`; `+ New domain`/`+ New binding` buttons on the Management UI; webhook adapters split credentials into auth + webhook_secret halves; `webhook_secret_credentials_id` migration (0007); fail-closed provisioning rollback; `defaultReviewModeFor` table per arch §307 + §364 | full pnpm test pass + `pnpm test:e2e -- domain-and-binding-create` against compose-spun Gitea | ~26 |

§1.2.10 deferred to phase-a-appendix #3: `setup --bootstrap-domain` CLI shortcut for partners who want a one-shot domain bootstrap from the command line. Out of scope here — the Management UI flow is enough to unblock the pilot cutover.

### 1.3 Phase-a exit gate

All must hold before tagging `0.1.0-a.N` and starting phase b:

- [ ] PRD §5 criteria 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 all green in CI. (Criteria 11 and 12 are phase-b and phase-c gates respectively; see §2.3 / §3.3.)
- [ ] **Pilot cuts over on phase-a code.** At least one pipeline runs on opencoo in parallel with the n8n equivalent; opencoo output quality ≥ n8n baseline on reviewer sign-off. The design partner begins operating on phase-a without waiting for SkillMiner — **SkillMiner adoption is a dedicated post-cutover sub-task in phase b** (CLAUDE.md "v0.1 ship sequence"; `architecture.md` §17 Resolved "Pilot migration path"). This is the single most important exit criterion.
- [ ] THREAT-MODEL §5 PR checklist run on the phase-merge commit — every box ticked or residual risk added to §7.
- [ ] `CHANGES-v0.1.md` drafted with breaking-change list from pre-release to `a.N`.
- [ ] Fresh `docker compose up -d` → operator can create one domain + one binding through the Management UI without psql, exercised by `pnpm test:e2e -- domain-and-binding-create` (phase-a appendix #2).

---

## 2. Phase b — `catalog-skills` + SkillMiner

Ships as `0.1.0-b.N` tags. Ships once phase-a is stable in pilot production. **This is the phase where the partner adopts SkillMiner via a dedicated sub-task** — phase-a does not ship SkillMiner to the partner, even though the phase-a foundations PRs create its storage (PRs 02, 03). The separation exists because SkillMiner is a deliberate scope-stretch past pilot-PoC parity (CLAUDE.md; `architecture.md` §17 Resolved "Pilot migration path") and the partner's production stability during cutover must not be coupled to an unproven pipeline.

### 2.1 Entry gate

- [ ] Phase-a exit gate green.
- [ ] Pilot has run phase-a deliverables in production for **≥ two weeks without a severity-1 incident**. This two-week soak is the adoption contract: the partner's environment is demonstrably stable on phase-a code before any SkillMiner behavior turns on.
- [ ] `miner_suppressions` + `catalog_candidate` + `miner_runs` tables present (should be, from PR 02 — recheck).

### 2.2 Deliverables

| PR | Title | Depends on | Test-first artifact | Acceptance | Verify | Files est. |
|---|---|---|---|---|---|---|
| 33 | `catalog-skills` class + Compiler template | PR 16 | `compiler-catalog-skill.test.ts` — `content_kind: 'skill-bundle'` bypasses DocumentConverter; Compiler template frontmatter-merge only; SKILL.md body verbatim; quarterly cadence; local-pinned LLM policy default | Catalog domain creation seeds default redaction pattern list (THREAT-MODEL §3.3) | `pnpm --filter engine-ingestion test compiler-catalog-skill` | ~10 |
| 34 | `source-skill-bundle` adapter | PR 33 | `source-skill-bundle.contract.test.ts` — unpacks `.skill` bundles; `content_kind: 'skill-bundle'` always; deterministic `source_revision` from bundle hash | Dedup on bundle SHA | `pnpm --filter source-skill-bundle test:contract` | ~8 |
| 35 | SkillMiner — Pass 1 Worker Detector | PRs 03, 07, 33 | `miner-detector.test.ts` — reads only from `scan_domains` on the binding; **schema test: the miner-binding row persists `scan_domains: string[]` column with `default '{}'` (Postgres empty-array); inserting a binding without `scan_domains` resolves to `[]`; creating a binding whose `scan_domains` contains a `catalog-*` slug is rejected at the DB layer with a typed error**; when `scan_domains = []` the detector is a no-op (writes a `miner_runs` row with `candidate_count: 0` and exits); `instance_count ≥ 3 ∧ confidence ≥ 0.7`; consults `miner_suppressions` by `pattern_fingerprint` (NFC + lowercase + stopwords-removed-per-locale + SHA-256); sovereignty: excludes `agent_runs` whose instance domain_scope doesn't intersect `scan_domains` (THREAT-MODEL §3.12) | `miner_runs` row per invocation regardless of candidate count | `pnpm --filter engine-ingestion test miner-detector` | ~12 |
| 36 | SkillMiner — Pass 2 Thinker Synthesizer + pre-summarization | PR 35 | `miner-synthesizer.test.ts` — pre-summarization sub-step when evidence > ~6k tokens; drafts agentskills.io-format `SKILL.md`; output-side redaction on `draft_payload.skill_md` (THREAT-MODEL §3.12); LLM policy inherits from target `catalog-skills` domain | `catalog_candidate` row written; status `detected → drafted` | `pnpm --filter engine-ingestion test miner-synthesizer` | ~10 |
| 37 | Review Dashboard — 5th item type (skill candidates) + slug-collision Supersede flow | PRs 28, 36 | `review-candidates.test.ts` — skill-candidate item type; slug-collision Supersede writes through `wikiWrite`; reject writes `miner_suppressions` row with reviewer + reason | Candidate never auto-promotes; quarterly review is advisory only | `pnpm --filter engine-self-operating test review-candidates` | ~12 |
| 38 | Miner UI tab + suppressions management | PRs 29, 37 | `miner-ui.test.ts` — suppressions list / un-suppress / view rejected reason; scan-window override; `opencoo miner run` CLI verb (§14.5) | | `pnpm --filter ui test:e2e miner` | ~10 |
| 39 | Redaction audit table + Execution Log integration | PRs 12, 28 | `redaction-audit.test.ts` — every redaction hit emits `redaction_events` row; Execution Log view surfaces them; content never logged | Append-only; Cleanup honors retention | `pnpm --filter engine-self-operating test redaction-audit` | ~6 |
| 40 | Phase-b e2e: miner produces candidates + marketplace gates accept stub | PRs 36, 38 | PRD §5 criterion 11 (and 12 stub — full marketplace in phase c) | | `pnpm test:e2e miner` | ~4 |

### 2.3 Phase-b exit gate

- [ ] PRD §5 criterion 11 green.
- [ ] Pilot has run SkillMiner on its own `agent_runs` for one quarterly cycle; at least one candidate reviewed.
- [ ] No severity-1 redaction incident (i.e. zero `redaction_events` rows where content leaked to a committed wiki page).
- [ ] THREAT-MODEL §5 checklist re-run.

---

## 3. Phase c — Overlay + marketplace live-fetch polish

Ships as `0.1.0-c.N` tags. Rolls up into `0.1.0` once stable at ≥ 1 partner.

### 3.1 Entry gate

- [ ] Phase-b exit gate green.
- [ ] Pilot or second partner has `automation-n8n-mcp` actively deploying workflows (disabled, gate-3 respected).

### 3.2 Deliverables

| PR | Title | Depends on | Test-first artifact | Acceptance | Verify | Files est. |
|---|---|---|---|---|---|---|
| 41 | Partner Builder-skill overlay loader | PR 25 | `overlay-loader.test.ts` — overlay repo loaded on adapter start + on-change; max-files + max-total-size enforced at load (DoS prevention — THREAT-MODEL §3.11); precedence `overlay > marketplace > builtin` on slug collision | Overlay is a Builder-skill source, full stop; not MCP-registered, not SkillMiner-fed | `pnpm --filter automation-n8n-mcp test overlay-loader` | ~8 |
| 42 | Management UI: Automation → "Builder skill overlay repo" — Create-in-Gitea + Use-existing-URL | PR 41 | `overlay-ui.test.ts` — create flow uses admin Gitea token to pre-seed repo + README + `skill-template.md` + team grant; use-existing validates URL + read access on save (§17 Resolved "Partner Builder-skill overlay") | One-time per-partner | `pnpm --filter ui test:e2e overlay` | ~10 |
| 43 | Marketplace live-fetch loop + `marketplace_updates` table UX | PR 25 | `marketplace-fetch.test.ts` — weekly polling of `czlonkowski/n8n-skills` Releases API; `target_commitish` verified AND tarball tree-SHA recomputed; fails closed on mismatch; writes `marketplace_updates` row with diff. **Never auto-activates a new skill version — assertion: after a fixture release becomes available, the Builder agent's resolved skill set still reports the vendored-pinned versions until `marketplace_updates.status` transitions to `'accepted'` via the Review Dashboard (PR 44); `agent_runs.skills_used` written by a post-fetch Builder run carries the old `sha`, not the new one** (THREAT-MODEL §3.11) | Air-gap partners can disable at setup wizard; disabled-fetch state is explicit, not an error | `pnpm --filter automation-n8n-mcp test marketplace-fetch` | ~10 |
| 44 | Review Dashboard — Marketplace Updates entries | PRs 28, 43 | `review-marketplace.test.ts` — 4th item type surfaces diff + accept/skip; accept persists new pin SHA + refreshes vendored cache | Rejected updates do not re-surface until a newer version appears | `pnpm --filter engine-self-operating test review-marketplace` | ~8 |
| 45 | Phase-c e2e: marketplace-gates-accept + upgrade-preserves-overrides | PRs 43, 30 | PRD §5 criteria 10, 12 | | `pnpm test:e2e upgrade marketplace` | ~4 |

### 3.3 Release gate — `0.1.0`

All must hold before tagging `0.1.0`:

- [ ] Every PRD §5 criterion green — including criterion 13 (at least one pipeline demonstrably cut over at the design partner, n8n version paused, opencoo version live).
- [ ] THREAT-MODEL §6 release checklist run end-to-end.
- [ ] `SECURITY.md` reviewed; maintainer MFA + vulnerability-reporting address still valid.
- [ ] `CHANGES-v0.1.md` complete: every breaking change, every new default, every migration action from pre-release to `0.1.0`.
- [ ] Docker images pushed to GHCR + Docker Hub with GPG-signed release tags; CI verified signatures before publish.
- [ ] `deploy/BACKUP.md` present; `docker-compose.yml` volumes annotated with backup=yes/no/cache.
- [ ] `opencoo doctor` run against a fresh install — every check passes.
- [ ] Install telemetry payload shape matches the documented schema (or CHANGES entry + UI wizard update).
- [ ] Partner sign-off on PRD §5 criterion 13.

---

## 4. Risk register

Delivery risks that can block the plan (distinct from the security residual risks in THREAT-MODEL §7).

| Risk | Likelihood | Mitigation | Trigger to escalate |
|---|---|---|---|
| PoC doesn't stabilize in time | Medium | Pre-coding gate is explicit; we don't start phase-a early | Any attempt to open phase-a PR 01 before §0 exit criteria green |
| Pilot cutover stalls at criterion 13 | Medium | Phase-a is releasable at `0.1.0-a.N`; partner doesn't need `0.1.0` to operate | Three consecutive weeks without a pipeline cutover |
| Injection corpus proves too permissive | Medium | Phase-a PR 31 is a hard gate; fixtures expand as new classes are found | Any production prompt-injection incident |
| LLM provider deprecation mid-phase | Low | Per-domain policy means one domain's breakage is contained; router has typed errors, not silent fallback | Any provider SDK major-version bump |
| Adapter contract tests flaky in CI | Medium | Contract tests against real systems use service-containers, not live APIs, where feasible; pin SDK versions | Flake rate > 5% on any contract suite |
| Drizzle schema divergence PR-to-PR | Low | CLAUDE.md + `architecture.md` §14.4 name the single-ownership rule; ESLint enforces; schema-first PR ordering | Any PR adding a `pgTable` outside `packages/shared/db/schema/` |
| Overlay / marketplace DoS attack surface | Medium | Phase-c PR 41 enforces max-files + max-total-size at load | CI fuzz test catches a path that OOMs the loader |

---

## 5. Out-of-band operating rules

Independent of phase.

- **Update documentation in the same PR** that changes the code it describes. `architecture.md`, `THREAT-MODEL.md` §3, `DECISIONS.md`, and this plan drift silently if this rule is violated.
- **Prefer editing** this plan over spawning a new doc. Phases expand; the structure does not.
- **Gate discipline is non-negotiable.** Skipping phase-a exit criteria to start phase-b is how quality regressions ship.
- **One adapter per package.** Adding an integration = adding a package + a `credentialSchema` + passing the shared contract suite. The shared suite lives in `packages/shared/adapter-contract-tests/`.
- **No new env vars for feature config.** Ever. (THREAT-MODEL §2 invariant 9.) If a PR proposes one, push back to Postgres + UI.

---

*Derived from `architecture.md` v0.1 (2026-04-23), `THREAT-MODEL.md` v1, `DECISIONS.md` 2026-04-23, `CLAUDE.md` "v0.1 ship sequence". When this plan drifts, update it in the same PR as the code change.*

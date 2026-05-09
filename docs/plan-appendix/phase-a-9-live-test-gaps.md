# Phase-a appendix #9 — live-test gaps (close the ingestion + agents-team smoke loop)

> **Status:** ✅ closed · 2026-05-09 · 14 PRs across 5 waves + 1 fix-up follow-up · ~36 hours of agentic work · pointer in `IMPLEMENTATION-PLAN.md` §1.2.17.

---

## Why this exists

`0.1.0-a` had shipped to a tag, but a real Chrome session against the live management UI on 2026-05-08 surfaced 11 reproducible gaps that reduced v0.1 from "ships to a partner" to "ships to an engineer who already knows the workarounds." Two further scope additions — schema-aware LLM-policy editor and a live-pilot end-to-end test — were folded in per the planning Q&A so the partner cutover sign-off is the only remaining tag gate.

None of the 14 PRs add new product surface; all close the gap between "engine boots clean" and "operator drives a real binding through to a wiki write without an engineer next to them."

## PR roster

| PR | Title | Merge | Notes |
|---|---|---|---|
| Q0 | Husky post-checkout fresh-worktree guard | `ae01dc5` (#66) | Zero-hash guard skips install + build on `git worktree add`. |
| Q1 | SSE auth via fetch-streaming | `0c996bc` (#70) | EventSource → fetch-streaming with Bearer; Activity feed unblocks `CONNECTING`. |
| Q2 | Agent runners drizzle wrap | `80ad861` (#67) | `pg.Pool` wrapped with `drizzle(...)` once at registry build. |
| Q3 | MCP HTTP Accept header | `33fbcf0` ※ (one-line in `mcp-tool-client/http.ts`) | `application/json, text/event-stream` per Streamable HTTP spec. |
| Q4 | OpenRouter provider wiring | `0bef282` (#68) | `PROVIDERS` enum + `createProvider` switch + `PROVIDER_ENV_OPTS`. |
| Q5 | Migration 0010 USING clause + migrate-applies-clean test | `206b598` (#69) | `text → uuid` with `USING delivery_id::uuid` + new pglite-replay smoke test. |
| Q6 | Shared Fastify mount (PORT collision) | `11428ed` (#72) | Engine-ingestion webhook routes mount onto self-op's Fastify via pre-listen hook + body-limit threading. |
| Q7 | Receiver per-adapter signature + inner-secret extraction | `3924d3a` (#74) | Adapter-routed `extractSignature()` + `extractWebhookSecret()`; symmetric `wrapWebhookSecret()` for handshake; signature-header normalisation. |
| Q8 | Asana asanaClient injection + agents-seed defaults | `737fe3b` (#75) | `makeAsanaClient` factory pattern; `agents seed --domain <slug>` defaults `memory: '{"type":"none"}'` + scope-domain. |
| Q9 | Sources binding wizard renders binding-config schema | `75b900c` (#76) | `bindingConfigSchema` exposed via `/api/admin/adapters`; wizard renders config step; API write path validates + persists `config` jsonb; round-2 wires schema defaults through the missing-required gate. |
| Q10 | Sources row drill-down (webhook URL + actions) | `aacbe2d` (#77) | New `SourceBindingDetail` modal: webhook URL + copy + Disable + Delete; PATCH/DELETE routes added to admin API. |
| Q10b | Q10 Copilot triage follow-up | `7e67e53` (#79) | DELETE TOCTOU close (`RETURNING id` inside tx + `ConcurrentDeleteError` sentinel); `isPgForeignKeyViolation` narrowing → 409 vs 500; i18n error mapping (`disableFailed`/`enableFailed`/`auth`/`transient`). |
| Q11 | CredentialForm grouped labels | `2dfde5e` (#73) | Section heading per dot-prefix + humanised leaf labels; a11y `<h3>` + interleave reset. |
| Q12 | gitea-wiki-mcp-server per-request transport | `3d6b01f` (#71) | Per-request `Server` instance + transport so concurrent `/mcp` POSTs stop tripping "Already connected to a transport." |
| Q13 | LLM-policy schema-aware editor | `e09f2a4` (#78) | Static `MODEL_CATALOG` + `GET /api/admin/llm-models`; three-tier UI editor with provider dropdown + custom-input fallback for openrouter/ollama; `onValidityChange` gate; stale-model auto-flip; catalog-null fallback for every provider; all strings under `llmPolicy.editor.*` (en + pl). |
| Q14 | Live-pilot end-to-end integration test | `8db8419` (#80) | New `tests/live-pilot.real-pg.test.ts` (618 lines) + `tests/helpers/live-pilot/server.ts` (293 lines); gated on `RUN_REAL_PILOT=1`; nightly workflow `.github/workflows/nightly-live-pilot.yml`; afterAll `stopCompose` gated on `ENABLED && HAS_DOCKER && !CI` so the workflow's failure log capture wins. |

## What changed in process

- **Subagent-driven implementation, isolated worktrees.** Each PR's implementer ran in `git worktree add` isolation; main thread reviewed, pushed, triaged Copilot, merged. Q0 was the prerequisite — it eliminated the husky post-checkout install+build on every fresh worktree creation.
- **Copilot triage before merge.** User-stored memory rule: every PR's Copilot inline comments triaged before `gh pr merge`. Q5 was merged once without triage and self-flagged; Q10 was merged once without triage and the follow-up was opened as PR-Q10b. Net: every substantive Copilot comment in this appendix was addressed in a follow-up commit on the same branch before merge (or split into a clearly-named follow-up PR).
- **Plumbing-level fixup.** PR-Q10b's stale-comment fix landed on the wrong branch due to local worktree-state drift; recovered via `git hash-object` → `git read-tree` → `git commit-tree` → `git update-ref` on `prq10b-followups` directly. Documents one of the two recurring footguns of multi-worktree agentic dev.

## Open follow-ups (logged as tasks, not blocking the appendix close)

- Task #47 — SSE 401 terminal-state handling. Small follow-up; Q1's reconnect loop currently retries on 401 even though the PAT is durably bad. Add a terminal-state branch.

## Dependencies on the broader plan

- v0.1 exit-gate items: this appendix does not introduce any new exit-gate items. Partner-cutover sign-off remains the single remaining gate per `IMPLEMENTATION-PLAN.md` §1.3.
- THREAT-MODEL §5: PR-Q7 changes the receiver auth path; PR-Q9 expands the admin-API write surface; PR-Q10 adds DELETE; flag those for the next §5 walk. Live-pilot nightly CI run (PR-Q14) is itself the strongest §5 evidence going forward.

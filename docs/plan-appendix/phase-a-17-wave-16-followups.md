# Phase-a appendix #17 — Wave-17 · Wave-16 operational follow-ups

> **Status:** scoping doc lands as PR-WZ0; six implementation PRs follow in one parallel phase; WZN closes the wave.
> **Wave shape:** finishing work surfaced as explicit deferrals in wave-16's WZN closeout and in wave-15's W12 closeout. No new architectural direction; this is the operational tail of the impeccable-UX wave plus one carried-forward Cleanup-pipeline deferral and one server-side flake fix.
> **Predecessor:** wave-16 (`docs/plan-appendix/phase-a-16-impeccable-ux.md`) closed `0.1.0-a.14.*`. Native `<dialog>`, Skeleton, Tooltip, semantic landmarks, Field ARIA chain, code-splitting, EmptyStatePanel, Toast, locale switcher, Display, hover, live regions, keyboard nav, useLiveValidation, useOptimisticPatch (initial wiring), OnboardingWizard, Polish locale full pass, density toggle, contrast sweep, axe-core CI, perf marks (Domains route only), and cross-route visual-consistency snapshot all landed. Wave-17 ships as `0.1.0-a.15.*`.

---

## Context

Wave-16 made the UI **impeccable** in three orthogonal dimensions — accessibility, perceived performance + onboarding, visual depth + locale + in-app help. But the wave's WZN closeout flagged six explicit operational follow-ups: pieces that ship as natural finishing for wave-16's new primitives, plus one carried-forward wave-15 deferral that finally has the right context to land.

**B5 optimistic-PATCH wiring is partial.** B5 (`useOptimisticPatch`) shipped the hook + saving-cue + rollback toast + a representative wiring on `agent_instances.enabled` + `output_channels.enabled`. Eight more fields are in the whitelist but haven't been wired yet — the hook is general-purpose; the wiring is mechanical. The deferral happened because three of the four target detail surfaces (AgentInstanceDetail's name/locale/scope_domain_ids editor; SourceBindingDetail's notes/retention_days_override panels; DomainDetail's Configuration section) use an explicit-Save-then-close-modal pattern instead of inline single-field edits. The hook still applies — the optimism shifts the value-write timing on the row beneath the modal, not the modal contents themselves. Wave-17 finishes the wiring.

**B8 perf-marks instrumentation covers one route.** B8 shipped the `performance.mark` instrumentation library, the `PerfPanel` dev surface, and a representative end-to-end wiring on Domains. The other ten routes (Sources, Agents, Outputs, Prompts, Reports, Activity, Audit, Review, Cost, LlmPolicy) need the same `markRouteFetchStart` / `markRouteFetchEnd` pair inserted around their primary data-fetch boundary. Mechanical; finishing.

**Cleanup pipeline still reads only `domains.retention_days`.** Wave-15 W5 shipped the `sources_bindings.retention_days_override` column + admin-API PATCH branches + UI editor at write-time. The Cleanup pipeline (BullMQ job, weekly cadence) still queries `domains.retention_days` only — the per-binding override is honored when operators set it via the UI, but not when the Cleanup worker actually sweeps. Operators today see the chip set on the binding row but no behavior change. This finally has the right context: the wave-14 W3 intake-failed terminal state + the wave-15 W5 column means a per-binding age-out has a real use case (a noisy temporary binding can age out faster than its sibling under the same domain). Wave-17 closes the loop.

**Per-row Retry buttons on the W4 intake panel are stubbed.** Wave-14 W4 shipped the `SourceBindingDetail` "Intake state" panel that surfaces failed-intake rows with their `error_class` + `error_text` + last-event-at. The panel rendered per-row Retry buttons but disabled them with a stub comment because the W2 admin-API path (`POST /api/admin/source-bindings/:id/intake/:intakeId/retry`) wasn't wired through the StartOptions → server-factory composition route. Wave-14 Y8 (`afb961c7` / #133) closed the binding-level retry wiring but not the per-intake wiring. Wave-17 finishes the wire.

**Asana `assignee_gid` channel-config UI is missing.** Wave-14 W5 added `assignee_gid` + `section_gid` + `due_date_policy` + `title_prefix` to the `output-asana` channel-config schema; the heartbeat-to-Asana shape reads these correctly. The Outputs tab's per-channel config form renders the credential selector and the section/due-policy/title fields, but `assignee_gid` was deferred because the Asana adapter doesn't yet expose a "list users" query for an operator to pick from. Wave-17 ships either (a) a free-form text input with a "How do I find a user gid?" tooltip, or (b) wires a one-off list-users query into the credential-validated flow. Decision in the W5+ PR.

**`packages/cli/tests/output-channels-registry.test.ts` raised post-test EAI_AGAIN unhandled rejections** that exit-1'd vitest on four wave-16 PRs (A1, B3, A7, WZN). The test itself passed (870/873) but a lingering DNS lookup against an Asana stub host couldn't resolve under CI's restricted egress; the unhandled rejection bubbled past Vitest's test-isolation boundary. Each rerun cleared, but the rerun cost real CI minutes and merge-train coordination. Wave-17 hardens the test: either cancel pending lookups in `afterEach`, stub DNS at the module-mock level, or stop the test from ever issuing a real `getaddrinfo` call.

The wave is small (six implementation PRs, ~1-2 days), low-risk (every change extends an existing primitive or fills a documented stub), and ships as `0.1.0-a.15.*`. No new abstractions; no new schemas; no new env vars; no new admin routes (the per-intake retry route already exists per Y8 — the wave just finishes its wire). Per-PR test discipline + THREAT-MODEL §5 + Copilot triage as always.

---

## Wave roster

8 PRs total. Sub-wave letters reflect topical grouping; all 6 implementation PRs are independent and fan out in a single parallel phase after WZ0 lands.

### Phase 0 — Scoping (1 PR, serial)

- **WZ0** — this scoping doc, ported into the repo at `docs/plan-appendix/phase-a-17-wave-16-followups.md`. No code.

### Phase 1 — Implementation (6 PRs, parallel)

- **B5+** — `useOptimisticPatch` wiring expansion. Extend the optimistic surface from the wave-16 baseline (2 fields) to the full whitelist (10 fields total). Specifically: `agent_instances.{name, locale, scope_domain_ids}` on `AgentInstanceDetail`; `source_bindings.{notes, retention_days_override}` on `SourceBindingDetail`; `domains.{display_name, default_locale, worldview_enabled}` on `DomainDetail`; `output_channels.name` on `OutputChannelDetail`. Each wire reuses the `useOptimisticPatch` hook + B7 alert toast for rollback + the saving-cue dot. The wiring respects the existing explicit-Save-then-close-modal UX where present (the optimism applies to the row underneath the modal). Per-field unit test mirrors the B5 baseline test (success path + 422-rollback path + audit-row-absent-on-rollback pin).

- **B8+** — perf-marks expansion. Apply the B8 pattern from `Domains.tsx` to the other ten routes: Sources, Agents, Outputs, Prompts, Reports, Activity, Audit, Review, Cost, LlmPolicy. Each route's primary `fetchAdmin(...)` data-fetch boundary gets `markRouteFetchStart(tab)` immediately before + `markRouteFetchEnd(tab)` in the resolved branch. `PerfPanel` renders the new entries automatically. Per-route tests already exist; this PR doesn't add new tests, only the instrumentation. Lighthouse / web-vitals collection now spans every route on every wave-end run.

- **W5+** — Cleanup pipeline reads `sources_bindings.retention_days_override` at sweep-time. Server-side change. The Cleanup BullMQ worker (`packages/engine-ingestion/src/pipelines/cleanup/cleanup-worker.ts` — verify path) currently queries `WHERE created_at < NOW() - INTERVAL '<domain.retention_days> days'` against `ingestion_intake` (and related per-binding tables) per the wave-12 PR-Z6 Cleanup wiring. Switch the query to `WHERE created_at < NOW() - INTERVAL '<COALESCE(b.retention_days_override, d.retention_days)> days'` — joining `sources_bindings` so the override wins when set. New unit + integration tests pin the COALESCE behavior across (override set, override null, mixed bindings under one domain). No schema change; no migration.

- **W4+** — Per-row Retry buttons on the W4 intake panel. Wire the existing `POST /api/admin/source-bindings/:id/intake/:intakeId/retry` admin route into the disabled-stub Retry buttons in `SourceBindingDetail.tsx`'s Intake-state panel. Same admin-team-gated + CSRF + audit-write-before-mutate invariants as the binding-level Retry from wave-14 Y8. On retry: the failed intake row's `intake_status` flips to `pending`, the matching classify job re-enqueues, and the Activity feed receives a `pipeline.intake_retried` SSE event. Toast confirms via `useToast()` (B7). Unit test pins the API call + toast + row-state transition; existing wave-14 W4 panel tests stay green.

- **Asana** — `assignee_gid` UI on output-channel config. Decision in the PR: either (a) free-form text input with a "How do I find a user gid?" tooltip pointing at Asana's "Workspace Members → 3-dot menu → Get URL → gid is the last segment" docs path, or (b) a one-time `GET /users?workspace=<gid>` fetch when the credential is selected, rendering a `<select>` of "name (gid)" rows. The implementer chooses based on whether the Asana adapter exposes a `listUsers(credId, workspaceGid)` helper. If (a): pure UI change, no adapter work. If (b): tiny adapter extension. Unit tests cover both paths.

- **Flake** — Fix `output-channels-registry.test.ts` post-test EAI_AGAIN unhandled rejection. Investigate root cause: the test boots a fake production composition that lazy-loads an Asana adapter, which on first call (even with no credentials) issues a `getaddrinfo` for the API host. CI's egress is restricted; the lookup fails post-test as the test file unmounts; the unhandled rejection bubbles past vitest's `afterEach` boundary and exit-1's the shard. Fix paths: (1) stub `dns.lookup` at the test-module-mock level; (2) inject an `AsanaClient` mock that never resolves DNS; (3) `afterEach` cleanup that calls `AbortController.abort()` on any in-flight lookups. The implementer chooses the smallest-diff approach + adds a pin-test that asserts the test file completes without unhandled rejections (vitest's `--reporter=verbose` should expose this).

### Phase 2 — Closeout (1 PR, serial last)

- **WZN** — `CHANGES-v0.1.md` wave-17 closeout (Added / Risk-residual mirroring wave-16's WZN), `IMPLEMENTATION-PLAN.md` §1.1 status snapshot prepend + new §1.2.27 wave row; ships under `0.1.0-a.15.<final>`.

---

## Cross-cutting design decisions

**No new abstractions.** Every PR in wave-17 extends an existing primitive — `useOptimisticPatch` (wave-16 B5), `markRouteFetchStart`/`End` (wave-16 B8), the existing Cleanup BullMQ worker (wave-12 Z6), the wave-14 W4 Retry-button stubs, the wave-14 W5 Asana channel-config schema, an existing test file. No new shared package, no new ESLint rule, no new schema column, no new admin route, no new env var.

**Optimistic UI still doesn't weaken audit-write-before-mutate.** Same B5 invariant: server-side audit row writes BEFORE the UPDATE. On client rollback, no audit row exists. Pin-test for every new B5+ wire confirms the rollback path leaves no audit row. The B5 blacklist (sovereignty-token flows, credential rotation, `memory_clear`, deletes) is preserved in B5+ — no field on those code paths enters the optimistic whitelist.

**Cleanup pipeline change is additive and reversible.** The COALESCE query collapses to the existing behavior when `retention_days_override IS NULL` for every row, which is the current production state for the design partner. The query change is backward-compatible at the migration level (no schema change) and at the data level (NULL columns behave as if they don't exist).

**Per-intake retry uses the existing admin route.** The `POST /api/admin/source-bindings/:id/intake/:intakeId/retry` route was added in wave-14 Y8 alongside the binding-level retry route; both share the admin-team gate, CSRF protection, and audit-write-before-mutate ordering. W4+ only enables the disabled UI button — no server-side change.

**Asana `assignee_gid` UI prefers free-form-with-tooltip.** Operator-research signal is weak; partner deployment has 1 Asana operator who knows how to find a user gid. A one-off `GET /users?workspace=` query adds 30 lines of adapter code + a new test fixture; a tooltip adds 5 lines + an `i18n.help.assigneeGid.body` key. The implementer ships (a) unless the adapter helper turns out to be in scope for free.

**Flake fix is correctness, not flake-mitigation.** The current test issues a real DNS lookup against an unreachable host. This is wrong: a unit test should not make network calls. The fix isn't "retry on transient failure" — it's "stop making the call." The pin-test asserts the test completes without unhandled rejections.

---

## Verification (wave-end gate against `0.1.0-a.15.<final>`)

**Per-PR gates** (every PR before merge):
- `pnpm lint && pnpm typecheck && pnpm test` green at root.
- THREAT-MODEL §5 PR checklist run.
- GitHub Copilot inline triage cleared.
- New tests pin new behavior (TDD per `CONVENTIONS.md` §3).

**Wave-end gate**:

1. **Wave-16 regression** — re-run wave-16's wave-end gate (axe-core CI, contrast sweep, cross-route snapshot, locale parity, fresh-deploy onboarding, optimistic-rollback). Every wave-16 behavior still works.
2. **Cleanup pipeline behavior pin** — set `retention_days_override = 7` on a binding under a domain with `retention_days = 90`; force the Cleanup worker to run; verify intake rows older than 7 days on that binding age out + rows older than 90 days on sibling bindings remain.
3. **Per-intake retry walk** — synthesize a failed intake; click the per-row Retry button in `SourceBindingDetail`; verify the row's `intake_status` flips back to `pending`, the matching classify job is re-enqueued, Activity feed receives `pipeline.intake_retried` SSE.
4. **Optimistic-rollback expansion** — force a 422 on each new B5+ wire (8 fields × synthetic invalid value); verify rollback + B7 alert toast for each.
5. **Lighthouse coverage** — verify `window.opencoo_perf` now contains entries for every route (not just Domains).
6. **Asana `assignee_gid` walk** — set the field via the UI; fire a heartbeat to the Asana channel; verify the Asana task assigns to the right user.
7. **CI run noise** — over the wave's PR train, CI shouldn't need any reruns for the `output-channels-registry.test.ts` EAI_AGAIN flake.
8. **THREAT-MODEL §5 maintainer walk** — no new state-changing routes, no new attack surface; only existing-primitive wiring + a server-side Cleanup query change (read-then-delete pattern unchanged).

---

## Out of scope (explicit, defer to v0.2)

The following items appeared in wave-16's WZN closeout but require explicit scoping conversations before they can move — they're not "follow-up" work, they're new strategic directions:

- **Native-Polish-speaker review of C3's translation** — per explicit user direction, scheduled as a separate PR after wave-17 and any other operational wave-17-style follow-ups.
- **Mobile / narrow-viewport graceful degradation** — opencoo is a desktop operator console by architectural design; adding mobile is a product-scope decision, not a UI polish. v0.2.
- **Full WCAG 2.2 AAA** — 7:1 contrast everywhere + 24px target sizes + further tightening. Would require redesigning every paper/ink combination again. AA floor (just landed in wave-16) is what regulated adopters require for procurement. v0.2.
- **Dark mode (`prefers-color-scheme: dark`)** — paper-on-ink is a deliberate design choice per `design_system/README.md`. Dark variant requires a second contrast sweep + accent recalibration + likely a v2 of `colors_and_type.css`. v0.2.
- **Real-browser pixel-diff visual regression** — C7's jsdom structural snapshot is the v0.1 fence; a Playwright + visual-regression suite (Chromatic or Percy) is an order of magnitude more expensive to maintain. v0.2 unless C7 misses real drifts.
- **Per-screen density override** — single global density only per the wave-16 C6 design decision; per-screen violates the "one spacing scale" rule. Rejected, not deferred.
- **Fourth glyph promotion** — `?` character stays as the Tooltip trigger; `info-dot` composition deferred to operator-research signal. Rejected, not deferred.

Wave-15-deferred prompt-editor improvements (Monaco, 3-way merge UI for stale overrides), per-prompt rate-limit / budget knobs, single-use sovereignty tokens within TTL, and concurrent-edit locking on prompt overrides are also out of wave-17. They're real product work but bigger than wave-17's operational-finishing scope and benefit from a dedicated security-hardening wave once the partner deployment has been running on wave-16 for a soak period.

---

## Reuse — call these, do not reinvent

- `packages/ui/src/hooks/useOptimisticPatch.ts` (wave-16 B5) — the hook is general-purpose; B5+ wires more consumers without changing it.
- `packages/ui/src/components/SavingDot.tsx` (wave-16 B5) — the saving-cue primitive; reuse verbatim.
- `packages/ui/src/components/{AgentInstanceDetail,SourceBindingDetail,DomainDetail,OutputChannelDetail}.tsx` (waves 13–16) — extend the existing detail surfaces; don't rebuild.
- `packages/ui/src/lib/perf-marks.ts` (wave-16 B8) — the `markRouteFetchStart` / `markRouteFetchEnd` helpers are already exported.
- `packages/engine-ingestion/src/pipelines/cleanup/cleanup-worker.ts` — the Cleanup BullMQ worker (verify exact path; the wave-12 PR-Z6 wired it in).
- `packages/shared/src/db/schema/sources-bindings.ts` (wave-15 W5) — the `retention_days_override` Drizzle column is already there.
- `packages/engine-self-operating/src/admin-api/routes/source-bindings.ts` (wave-14 Y8) — the per-intake retry route `POST /:id/intake/:intakeId/retry` is already there. W4+ only wires the disabled UI button.
- `packages/adapters/output-asana/src/channel-config-schema.ts` (wave-14 W5) — `assignee_gid` is already in the schema; the UI just renders the field.
- `packages/cli/tests/output-channels-registry.test.ts` — the failing test; root-cause is real DNS lookup that should be stubbed.
- `packages/ui/src/components/Toast.tsx` (wave-16 B7) — `useToast()` for rollback toasts.
- `packages/ui/src/lib/announce.ts` (wave-16 A4) — `pushAnnouncement` bridges through `useToast()` automatically.
- `packages/ui/src/lib/safe-error.ts` — every operator-facing error message routes through here.
- `docs/plan-appendix/phase-a-16-impeccable-ux.md` — wave-doc style template; this appendix matches the prose density + section structure.

---

## Critical files to be modified

- `packages/ui/src/components/AgentInstanceDetail.tsx` (B5+: name/locale/scope_domain_ids wires)
- `packages/ui/src/components/SourceBindingDetail.tsx` (B5+: notes/retention_days_override wires + W4+: Retry button wiring)
- `packages/ui/src/components/DomainDetail.tsx` (B5+: display_name/default_locale/worldview_enabled wires)
- `packages/ui/src/components/OutputChannelDetail.tsx` (B5+: name wire + Asana: assignee_gid UI)
- `packages/ui/src/routes/{Sources,Agents,Outputs,Prompts,Reports,Activity,Audit,Review,Cost,LlmPolicy}.tsx` (B8+: instrument data fetch boundaries)
- `packages/ui/src/locales/en.json`, `pl.json` (Asana: `help.assigneeGid` + W4+: retry confirm/error strings)
- `packages/engine-ingestion/src/pipelines/cleanup/cleanup-worker.ts` (W5+: COALESCE query)
- `packages/engine-ingestion/tests/pipelines/cleanup-retention-override.test.ts` (NEW — W5+)
- `packages/cli/tests/output-channels-registry.test.ts` (Flake fix)
- `packages/ui/tests/unit/{agent-instance,source-binding,domain,output-channel}-detail-optimistic-expansion.test.tsx` (NEW or extend — B5+)
- `packages/ui/tests/unit/intake-retry-button.test.tsx` (NEW or extend — W4+)
- `packages/ui/tests/unit/output-channel-asana-assignee.test.tsx` (NEW — Asana)
- `IMPLEMENTATION-PLAN.md` §1.1 snapshot + new §1.2.27 wave row (WZN)
- `CHANGES-v0.1.md` wave-17 closeout section (WZN)
- `docs/plan-appendix/phase-a-17-wave-16-followups.md` (NEW — WZ0 ports this plan)

---

*Derived from wave-16 WZN closeout (`docs/plan-appendix/phase-a-16-impeccable-ux.md`), wave-15 W12 closeout, wave-14 Y-series follow-ups (Y8 per-binding retry wiring), and a flake-pattern analysis across A1/B3/A7/WZN CI reruns showing the `output-channels-registry.test.ts` EAI_AGAIN unhandled rejection as the recurring noise source. When this plan drifts, update it in the same PR as the code change.*

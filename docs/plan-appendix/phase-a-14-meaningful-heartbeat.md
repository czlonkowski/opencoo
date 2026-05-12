# Phase-a appendix #14 — Meaningful heartbeat (unblock + observability + content shape)

> **Status:** scoping doc landing as PR-W0; W1–W7 follow.
> **Wave shape:** 7 implementation PRs across 3 sub-waves (A unblock · B observability · C content), plus W7 closeout.
> **Predecessor:** wave-13 (phase-a appendix #13) shipped the agent-output pipeline — `compileDomainWorldview` wired into production, `agent_instances.output_channel_ids` bindable via UI, `output-webhook` registered in composition, per-(agent, adapter) transformers emitting Asana `html_notes`. The end-to-end heartbeat → Asana delivery path is live. Wave-14 is the response to the first real heartbeat task that landed: the **chain works, the content does not**.

---

## Context

Wave-13 closed under `0.1.0-a.8` (W0–W4 + the Y1–Y5 hotfix train: `gh pr view 117` through `124`). The first autonomous heartbeat → Asana task landed in the design-partner deployment's project end-to-end — the dispatcher iterated `agent_instances.output_channel_ids`, `mergePayloadFor({agentSlug: 'heartbeat', adapterSlug: 'asana'})` rendered the agent output as `html_notes`, the Asana adapter `POST /tasks` returned 201 with a task gid. The OutputChannelRegistry / dispatch path described in `architecture.md` §10 is producing real deliveries against a real adapter.

But the **content of that task is materially worse than the n8n pilot it replaces.** The title was the agent's `summary` field verbatim (no `[COO] Raport -- YYYY-MM-DD` shape, no date at a glance, variable length). The task had no assignee and no due-date — both fields the n8n baseline always set. The body was a regurgitated worldview placeholder ("the wiki has no compiled pages yet…") because the `wiki-<domain>` repo on the design-partner deployment is empty: the ingestion pipeline has been silently failing for 20+ hours and the heartbeat agent has no way to see why. The user reaction was the direct trigger for this wave: *"why there is absolutely no meaningful content?"*

A three-Explore-agent audit surfaced **a three-layer cascade gap**, not a single bug. Wave-14 closes all three so opencoo's autonomous heartbeat is genuinely useful — on populated wikis (synthesis-driven alerts from real compiled pages) AND on empty ones (operational-health alerts surfaced from intake state, binding lag, recent agent-run failures).

### Layer A — Pipeline silently blocked at the classifier guard

Roughly **260 `ingestion_intake` rows** sat at `status='pending'` for over 20 hours on the design-partner deployment. Every corresponding BullMQ `ingestion.scanner.classify` job is in the `failed` set with `BindingConfigError: binding.allowed_paths is empty — at least one specific glob is required`. Root cause: `assertBindingNotWildcardOnly` (`packages/engine-ingestion/src/classifier/binding-guard.ts:53–70`) is the runtime security boundary that rejects bindings with empty `allowed_paths` or wildcard-only globs (per `architecture.md` §3.5 — agents must never be able to write to arbitrary wiki paths). The schema column `sources_bindings.allowed_paths` (`packages/shared/src/db/schema/sources-bindings.ts:28`) defaults to `'{}'::text[]`. **No creation path populates it**: the admin-API POST body schema omits the field (`packages/engine-self-operating/src/admin-api/routes/source-bindings.ts:169–190`), the `NewSourceBindingModal.tsx` three-step UI flow has no `allowed_paths` step, the bootstrap scripts INSERT without it, and adapters don't filter at scan-time either. The guard is the sole consumer, and on a fresh deployment every binding fails it.

### Layer B — Failures invisible to the operator

Even if the operator suspects breakage, there is nowhere to look. The `intake_status` enum (`packages/shared/src/db/schema/enums.ts:23–27`) is `'pending' | 'classified' | 'skipped'` — **no failure terminal state**. The `ingestion_intake.error_class` and `.error_text` columns exist but nothing writes them: the compile-worker (`packages/engine-ingestion/src/pipelines/compilation-worker.ts:214–218`) updates intake to `classified` only on the success path, and there is no `try/catch` around `classify()` — the guard's throw bubbles to BullMQ, the job moves to the `failed` set, and the intake row stays `pending` forever. The admin-API source-binding GET response includes a `lastError` field (`source-bindings.ts:130–141`) but it reads `error_text`/`error_class` which are never populated, so it always returns `null`. SourceBindingDetail shows no per-status breakdown; the Activity Feed only surfaces agent runs; the Pipelines tab shows BullMQ counts in aggregate, not per-binding. Worst: the Heartbeat agent itself (`packages/engine-self-operating/src/agents/heartbeat/run.ts:52–126`) reads only worldview + page index + prior briefings — it has **zero observability** of intake state, BullMQ stats, source-binding lag, or `agent_runs` failure rates. It correctly observes "wiki is empty" but cannot see why.

### Layer C — Heartbeat content shape materially worse than n8n baseline

The transformer `heartbeatToAsana` (`packages/cli/src/provision/output-transformers.ts:297`) maps the agent's `summary` directly to the task title. The n8n baseline always wrote `[COO] Raport -- YYYY-MM-DD` so the task list scans cleanly. `asanaChannelConfigSchema` (`packages/adapters/output-asana/src/channel-config.ts`) supports `assignee_gid` but the transformer never sets a default. `AsanaTaskPayload.dueOn` exists (`payload-schema.ts:41`) but the transformer never sets it either; n8n always set `due_on: today` so the task showed "Dzisiaj" in the operator's task list. The worldview compiler (`packages/shared/src/prompts/en-worldview-domain.ts:50–52`) returns a single placeholder sentence on an empty domain, and the heartbeat prompt (`packages/shared/src/prompts/en-heartbeat.ts:33–67`) has no empty-wiki fallback guidance — the LLM dutifully regurgitates the placeholder as an "alert." There is no system-health awareness: even on an empty wiki the agent could surface intake-backlog count, failed-job count, source-binding scan lag, recent agent-run failure rates, lint findings count — but it has no tool, no input data, and no prompt branch to do so.

Wave-14 closes all three layers. Sub-wave A unblocks the pipeline (`allowed_paths` becomes a first-class binding property, with re-enqueue surface for already-failed jobs). Sub-wave B makes failures visible (`intake_status='failed'` terminal state + compile-worker error capture + UI surfaces). Sub-wave C reshapes heartbeat content (Asana channel-config knobs + system-health gatherer + empty-wiki prompt branch). After wave-14 the design-partner deployment's daily heartbeat is genuinely useful on both populated and empty wikis, and any future deployment with a misconfigured binding lights up in the UI within minutes instead of hiding for hours.

---

## Wave roster

- **W0** — this PR (scoping doc).
- **W1** — `allowed_paths` as a first-class binding property: POST/PATCH schema, 4th step in `NewSourceBindingModal`, `SourceBindingDetail` edit affordance, per-adapter `defaultAllowedPaths` descriptor field, bootstrap-script INSERTs. Closes Layer A's binding-creation gap.
- **W2** — Re-enqueue & retry surface for failed compile jobs: `POST /api/admin/source-bindings/:id/retry-failed` + "Retry failed jobs (N)" button on `SourceBindingDetail`. Closes the "I fixed `allowed_paths` but the 260 already-failed jobs are stuck" gap.
- **W3** — `intake_status='failed'` terminal state + compile-worker `try/catch` writing `error_class`/`error_text` before re-throwing. Closes Layer B's "failures invisible" gap at the data layer.
- **W4** — Operator-facing surfaces for failed intake: `SourceBindingDetail` "Intake state" panel + `GET /api/admin/source-bindings` `intake_counts` field + Activity Feed `pipeline.intake_failed` SSE event. Closes Layer B's UI gap.
- **W5** — `heartbeatToAsana` defaults + new Asana channel-config knobs (`assignee_gid`, `section_gid`, `due_date_policy`, `title_prefix`). Closes Layer C's title/assignee/due-date gap.
- **W6** — Heartbeat system-health gatherer + empty-wiki prompt branch: new `system-health.ts` pre-fetched at run-start, spotlighted into the prompt under a `system-health://<domainSlug>` envelope; prompt directs the LLM to surface operational-health alerts when the wiki is sparse. Closes Layer C's "no system-health awareness" gap.
- **W7** — Wave-14 closeout doc + `IMPLEMENTATION-PLAN.md` §1.1 status snapshot update.

---

## Sub-wave A — Unblock the pipeline (CRITICAL; gates partner usefulness)

### PR-W1 — `allowed_paths` as a first-class binding property

**Branch**: `phase-a-appendix-14/w1-allowed-paths-first-class`
**Size**: ~8 files · ~400 lines

The runtime guard `assertBindingNotWildcardOnly` is the security boundary and stays in place — defense-in-depth (`architecture.md` §3.5 invariant 2). W1 adds the missing input surface so operators can populate `allowed_paths` at create-time, fixes existing bindings via UI rather than SQL, and seeds per-adapter sensible defaults.

**Scope**:

- **`POST /api/admin/source-bindings`** (`packages/engine-self-operating/src/admin-api/routes/source-bindings.ts:169–190`): add `allowed_paths: z.array(z.string().min(1)).min(1)` to the body schema; pre-validate using the existing `assertBindingNotWildcardOnly` (re-exported from `binding-guard.ts` as a pure helper); reject at 422 with the same `BindingConfigError` message the runtime emits — operators see the same wording in both places.
- **INSERT path** (`source-bindings.ts:500–511`): include `allowed_paths` column on the row insert.
- **`PATCH /api/admin/source-bindings/:id`**: support updating `allowed_paths` so the operator can fix existing bindings via the UI instead of dropping to SQL. CSRF + admin-team + audit-write-before-mutate (same wave-13 W2 pattern as `PATCH /api/admin/agent-instances/:id`). New audit action `source_binding.set_allowed_paths` added to the allowlist (`admin-api/audit-log.ts`).
- **`NewSourceBindingModal.tsx`** (`packages/ui/src/components/`): add a 4th step "Allowed wiki paths" — chip-list input with per-adapter suggested defaults rendered as click-to-add chips (sourced from each adapter descriptor's new `defaultAllowedPaths` field below). Operator can edit/remove freely. Save dispatches the existing POST with the new field. 6 i18n keys (en + pl).
- **`SourceBindingDetail.tsx`**: show current `allowed_paths` as a chip list with an Edit button that calls the new PATCH route. 4 i18n keys.
- **`SourceAdapter` descriptor**: add optional `defaultAllowedPaths: readonly string[]` on the adapter descriptor (NOT on the runtime adapter — descriptors are pure metadata). Adapters export it; the UI reads it from `GET /api/admin/adapters`. v0.1 per-adapter defaults:
  - `source-drive` → `["meetings/**", "transcripts/**", "docs/**"]`
  - `source-asana` → `["projects/**", "tasks/**"]`
  - `source-fireflies` → `["meetings/**"]`
  - `source-n8n` → `["workflows/**"]`
  These are SUGGESTIONS, not enforcement — operators can replace.
- **Bootstrap scripts** (`scripts/smoke-real-data.ts:358`, any `packages/cli/src/commands/seed-*.ts` partner-seed scripts): INSERT with `allowed_paths` populated from the adapter's `defaultAllowedPaths` rather than relying on the empty-array default.

**Threat-model**:
- Runtime `assertBindingNotWildcardOnly` STAYS in place at the classifier — API-level pre-validation is UX, not a substitute. Two guards, same logic, same error class.
- PATCH gate: CSRF + admin-team + audit-write-before-mutate.
- `allowed_paths` is operator-controlled config (not user-derived or content-derived) so no injection surface.

**Tests** (write first):
- POST rejects empty `allowed_paths` with 422 + `BindingConfigError` message.
- POST rejects `["**"]` (wildcard-only) with 422.
- POST rejects `["**/foo"]` (still wildcard-shaped) with 422.
- POST accepts `["meetings/**", "transcripts/**"]` and INSERTs the row.
- PATCH happy path + audit-log entry written before the UPDATE.
- UI: modal renders the adapter's `defaultAllowedPaths` chips; can add/remove; Save sends the array in body.
- UI: `SourceBindingDetail` Edit path round-trips through PATCH.

**Reuse — do not reinvent**:
- `assertBindingNotWildcardOnly` + `BindingConfigError` from `binding-guard.ts` — re-export, call from API.
- PATCH-with-CSRF + admin-team gating pattern: existing `PATCH /api/admin/agent-instances/:id` from wave-13 W2.
- Audit-log allowlist convention: existing entries in `admin-api/audit-log.ts`.
- Modal 4th-step pattern: extend `NewSourceBindingModal.tsx`'s existing step machinery.

### PR-W2 — Re-enqueue & retry surface for failed compile jobs

**Branch**: `phase-a-appendix-14/w2-reenqueue-failed-jobs`
**Size**: ~4 files · ~200 lines

After W1 ships and the operational backfill populates `allowed_paths` on existing bindings, the BullMQ jobs in the `failed` set are stale — they failed against the old config and will not re-drive on their own. W2 gives the operator a UI button to re-enqueue them.

**Scope**:

- **`POST /api/admin/source-bindings/:id/retry-failed`**: enumerates `ingestion.scanner.classify` failed jobs whose `payload.bindingId === :id`, re-enqueues them as fresh jobs, returns `{ retriedCount }`. CSRF + admin-team + audit action `source_binding.retry_failed`.
- **UI button on `SourceBindingDetail`** next to "Scan now": "Retry failed jobs (N)" — disabled when N=0, shows the per-binding failed count from BullMQ stats. 3s cooldown + scrubbed-error toast pattern (same as wave-12 Z3 "Scan now").
- **BullMQ helper** (`packages/engine-ingestion/src/queue.ts`): new `enumerateFailedJobsByBindingId(queue, bindingId)` that `ZRANGE`s the `:failed` set and filters by hash payload. Pure read-side, no mutation.
- **i18n**: 4 keys.

**Threat-model**:
- New admin write surface — CSRF + admin-team + audit, same gate as wave-13 W2's PATCH route.
- Re-enqueue cannot escalate scope: jobs are re-driven through the same compile-worker which still hits `assertBindingNotWildcardOnly`.

**Tests**:
- `enumerateFailedJobsByBindingId` returns expected payloads filtered to the right binding.
- Retry route re-enqueues + audit-logs before enqueue.
- UI button reflects per-binding failed count.

**Reuse — do not reinvent**:
- "Scan now" cooldown + button pattern from wave-12 Z3.
- Admin-API CSRF gate from W1's PATCH route.

---

## Sub-wave B — Failure observability (operator can see breakage)

### PR-W3 — `intake_status='failed'` + compile-worker error capture

**Branch**: `phase-a-appendix-14/w3-intake-failure-state`
**Size**: ~6 files · ~300 lines

Add a failure terminal state to `intake_status` and wrap the compile-worker in a `try/catch` that writes `error_class`/`error_text` BEFORE re-throwing for BullMQ. This is the data-layer enablement for W4's UI surfaces and W6's heartbeat awareness.

**Scope**:

- **DB migration** (`packages/shared/src/db/migrations/0xxx_intake_failed.sql`): `ALTER TYPE intake_status ADD VALUE 'failed'`. Drizzle migration file alongside.
- **Schema** (`packages/shared/src/db/schema/enums.ts:23–27`): add `'failed'` to the enum's TypeScript literal type.
- **compile-worker** (`packages/engine-ingestion/src/pipelines/compilation-worker.ts`): wrap the body (~lines 109–218) in `try/catch`. On caught `OpencooError`: `UPDATE ingestion_intake SET status='failed', error_class=$err.kind, error_text=LEFT($err.message, 1000) WHERE id=$intakeId`, then re-throw so BullMQ moves the job to `failed`. On unknown errors: `status='failed', error_class='transient', error_text=err.message`, then re-throw.
- **Worker outer wrapper** (`workers/compile-worker.ts`): no behavioral change — BullMQ still sees the throw and moves the job to `failed`, same as today.
- **Source-binding GET `lastError`** (`source-bindings.ts:130–141`): already wired in shape; now actually populates with real data.

**Threat-model**:
- `error_text` is truncated to 1000 chars at write-time (LEFT()) to bound row size.
- No new admin surface; pure data-layer change inside the worker.
- Append-only invariant (`architecture.md` §3.3) is unaffected — `ingestion_intake` is mutable per `agent_runs` model (intake state machine, not append-only log).

**Tests** (write first):
- compile-worker test: stub `classify()` to throw `BindingConfigError`; assert intake row ends with `status='failed', error_class='validation', error_text='binding.allowed_paths is empty…'`.
- compile-worker test: stub `classify()` to throw unknown `Error`; assert `error_class='transient', error_text` set.
- compile-worker test: success path still sets `classified`, no error fields populated.
- Admin-API integration: `GET /api/admin/source-bindings` returns `lastError` populated after a failed intake row exists.

**Reuse — do not reinvent**:
- `OpencooError.kind` → `error_class` enum mapping already exists in `@opencoo/shared/errors`.
- `error_class` + `error_text` columns already in `ingestion_intake` schema (just unwritten until now).

### PR-W4 — Operator surfaces for failed intake

**Branch**: `phase-a-appendix-14/w4-failed-intake-surfaces`
**Size**: ~5 files · ~250 lines

Make the failures W3 captures visible — both as a panel on each binding's detail page and as live events in the Activity Feed.

**Scope**:

- **`SourceBindingDetail.tsx`**: add "Intake state" panel showing `{ pending, classified, skipped, failed }` counts, with the most-recent-3 failed rows (id + error_class + error_text snippet + Retry button per row calling W2's route scoped to one job).
- **`GET /api/admin/source-bindings`** (extend existing route, not new): include `intake_counts: { pending, classified, skipped, failed }` per binding. Lightweight aggregate `SELECT status, COUNT(*) FROM ingestion_intake WHERE binding_id=$1 GROUP BY 1`.
- **Activity Feed** (`packages/ui/src/routes/Activity.tsx`): SSE event emitted when the compile-worker writes a `failed` intake row; rendered in Feed tab as a `pipeline.intake_failed` event with binding name + error class + last-hour failure count.
- **SSE bridge** (`packages/engine-ingestion/src/workers/sse-bridge.ts:57–63`): already emits on job failure; extend to publish a `pipeline.intake_failed` event with `{ bindingId, errorClass, intakeId }` on the existing event bus.
- **i18n**: 6 keys.

**Threat-model**:
- `error_text` snippet truncated to 200 chars at render-time; UI renders via React text nodes (no `dangerouslySetInnerHTML`) — escaping is implicit in React's rendering.
- Counts query filters by `binding_id` which is admin-tab-scoped — no cross-tenant leak risk (`architecture.md` §3.5 scope check).
- SSE event publishes only `bindingId` (admin-visible), `errorClass` (enum), `intakeId` (UUID) — no `error_text` payload leaked through the bus.

**Tests** (write first):
- `GET /api/admin/source-bindings`: `intake_counts` present and accurate after W3 inserts a failed row.
- `SourceBindingDetail` panel: renders counts, lists failed rows, Retry button round-trips through W2 with single-job scope.
- Activity Feed: SSE event lands and renders the event row with the right labels.

**Reuse — do not reinvent**:
- `SourceBindingDetail` panel pattern — extend the existing component, don't refactor.
- SSE bridge pattern — already established in `sse-bridge.ts`.
- `escapeHtml()` — currently lives in `output-transformers.ts`; W5 stays inside `cli/`. W4 (UI-side) should use React text rendering (no `dangerouslySetInnerHTML`); W6's `error_text_snippet` truncation happens engine-side in the system-health gatherer before reaching the spotlight envelope. If a shared escape ever becomes necessary, the canonical move is to lift it into `@opencoo/shared` first.

---

## Sub-wave C — Heartbeat content shape (meaningful on populated AND empty wikis)

### PR-W5 — `heartbeatToAsana` defaults + Asana channel-config knobs

**Branch**: `phase-a-appendix-14/w5-heartbeat-asana-shape`
**Size**: ~6 files · ~250 lines

Reshape the heartbeat → Asana task so the title is scannable, the due-date and assignee land, and the body leads with the agent's executive summary. All knobs are channel-config (operator-settable), not hard-coded.

**Scope**:

- **Asana channel-config schema** (`packages/adapters/output-asana/src/channel-config.ts`): add optional `assignee_gid: string`, `section_gid: string`, `due_date_policy: "today" | "none"` (default `"today"`), `title_prefix: string` (default `"[COO] Raport -- "`).
- **Asana payload schema** (`packages/adapters/output-asana/src/payload-schema.ts:41`): `dueOn` already exists; ensure the underlying API call passes `memberships: [{ project: gid, section: gid }]` when `section_gid` is set on the channel.
- **Asana adapter `createTask`** (`packages/adapters/output-asana/src/asana-fetch-api.ts`): support optional `section_gid` via the `memberships` parameter on `POST /tasks`.
- **`heartbeatToAsana` transformer** (`packages/cli/src/provision/output-transformers.ts:297–325`): rewrite:
  - **Title**: `${channelConfig.title_prefix ?? "[COO] Raport -- "}${todayIso()}`. If `title_prefix` is an empty string, fall back to `${todayIso()} — ${summary.slice(0, 100)}` so it's still scannable.
  - **`dueOn`**: if `channelConfig.due_date_policy === "today"` → `todayIso()`; else omit (so the field doesn't conflict with `due_at`, which is mutually exclusive per the wave-13 Asana-quirks note in appendix #13).
  - **`assigneeGid`**: if `channelConfig.assignee_gid` is set, pass it through; existing behavior, unchanged shape.
  - **`htmlNotes`**: prepend `<h1>${escapeHtml(summary)}</h1>` so the agent's executive summary is the body lead. Per-alert `<h2>` sections follow as today — Asana's restricted-HTML tag whitelist (`<h1>`, `<h2>`, `<ul><li>`, etc. as siblings — see wave-13 appendix's Asana quirks note) is unchanged.
- **i18n**: 8 keys for the new channel-config form fields (en + pl).
- **UI**: the dynamic channel-config form already renders from `channelConfigJsonSchema` (no code change in `NewOutputChannelModal.tsx` needed — it's schema-driven). Verify the new fields render as expected text/select inputs.

**Threat-model**:
- All new fields are operator-controlled config, encrypted-at-rest only for the existing `credentials_id` (no new secrets).
- `escapeHtml` already applied to `summary` before splice into `<h1>` — no XSS surface even though Asana would strip unknown attributes anyway.

**Tests** (write first):
- Transformer unit tests: title with default prefix + today; title with custom prefix; `due_on=today`; `due_on=none` (field omitted); assignee set/unset; body has `<h1>summary</h1>` lead.
- Asana adapter: `createTask` with `section_gid` sets `memberships` correctly on the POST body.
- Channel-config schema accepts the new fields; rejects invalid `due_date_policy` value.

**Reuse — do not reinvent**:
- Existing `heartbeatToAsana` shape and per-alert rendering — reshape title and prepend summary; don't redo the per-alert HTML.
- Existing dynamic-channel-config form rendering (schema-driven).
- Existing `escapeHtml` + truncation logic.

### PR-W6 — Heartbeat system-health context + empty-wiki prompt branch

**Branch**: `phase-a-appendix-14/w6-heartbeat-system-health`
**Size**: ~7 files · ~400 lines

This is the meat of sub-wave C. Even when the wiki is empty, the heartbeat should surface operational health drawn from intake state, BullMQ stats, and recent agent-run history — instead of regurgitating the worldview placeholder.

**Scope**:

- **New system-health gatherer** (`packages/engine-self-operating/src/agents/heartbeat/system-health.ts`, NEW): pre-fetched at run-start in `run.ts`. Returns:
  - `intake_counts`: `{ pending, classified, skipped, failed }` for the heartbeat's scope domain(s).
  - `intake_failures_recent`: top 3 most-recent `failed` intake rows with `{ binding_name, error_class, error_text_snippet }` (snippet truncated to 200 chars; the system-health gatherer lives in `engine-self-operating` so any HTML-bound output is downstream of the LLM step, where the existing transformer in `cli/` re-escapes before splice into Asana `html_notes`).
  - `source_bindings`: per-binding `{ name, last_scan_at, hours_since_scan, pending_count, failed_count }`.
  - `recent_agent_runs`: last 24h `{ agent_slug, success_count, failure_count, last_failure_message }`.
  - `wiki_stats`: page count (excluding placeholders), worldview length in bytes, worldview `last_compiled_at`.
- **`runHeartbeat`** (`packages/engine-self-operating/src/agents/heartbeat/run.ts:52–126`): call the system-health gatherer, spotlight the result as a `system-health://<domainSlug>` envelope, append to the prompt before the LLM call.
- **`HEARTBEAT_OUTPUT_SCHEMA`** (`packages/engine-self-operating/src/agents/heartbeat/types.ts`): additive — alerts already shape `{ title, body, citations }`; output stays compatible with the existing transformer. Add optional `summary_kind: "operational" | "synthesis"` so the transformer can tell the difference (not required for v1 — purely informational).
- **Heartbeat prompt** (`packages/shared/src/prompts/en-heartbeat.ts` + `pl-heartbeat.ts`): add an empty-wiki branch directing the LLM to surface up to 5 operational-health alerts from the `system-health://` block when page count < 5: intake backlog, failed compile jobs (with binding name + error class), source-binding scan lag (last_scan > 24h), recent agent-run failures, worldview staleness. Explicitly direct: **do NOT regurgitate worldview placeholder text**. If wiki has > 5 pages, prefer synthesis-driven alerts; surface operational only when severity exceeds knowledge-side findings.
- **Worldview prompt** (`packages/shared/src/prompts/en-worldview-domain.ts:50–52` + pl): tighten empty-wiki branch — return a single sentence like "Domain has no compiled pages yet; operator should check Sources tab for ingestion state." so when the heartbeat reads it, the noise is minimal and the system-health context dominates.

**Threat-model**:
- The system-health gatherer reads ONLY from the heartbeat's scope domain — domainSlug × scopeDomainIds cross-check already done at run-start (`assertDomainSlugInScope` from the agent harness). Intake counts and binding stats filtered by `binding_id IN (SELECT id FROM sources_bindings WHERE domain_id IN ($scope))` — no cross-tenant leak.
- No new admin surface; pure data fetch internal to the agent run.
- `error_text_snippet` truncated to 200 chars before splice into the prompt envelope. The prompt envelope is plain text consumed by the LLM (not HTML), so HTML escaping is the wrong layer; the existing transformer in `cli/` performs HTML escape on the agent output when it later renders into `html_notes`.
- LLM-spotlight envelope (`system-health://<domainSlug>`) follows the same `spotlight()` shape `architecture.md` §3.4 mandates — LLM input is XML-bounded; sentinel/amp/xmlbody order applied.

**Tests** (write first):
- system-health gatherer returns expected shape; respects scope; truncates `error_text`.
- `runHeartbeat` unit test: with fake gatherer returning `intake_counts.failed > 0`, assert the spotlight block reaches the LLM prompt.
- Heartbeat e2e (stub LLM that echoes back the prompt fingerprint): when wiki has < 5 pages, the prompt includes the `system-health://` envelope.

**Reuse — do not reinvent**:
- `spotlight()` envelope from `@opencoo/shared/spotlight`.
- `loadPrompt()` from `@opencoo/shared/prompts`.
- Existing `HEARTBEAT_OUTPUT_SCHEMA` shape (additive only — don't break the existing transformer).
- Existing `assertDomainSlugInScope` from the agent harness.

---

## W7 — Wave closeout

**Branch**: `phase-a-appendix-14/w7-closeout`
**Size**: ~2 files · ~120 lines

Append the wave-14 closeout section to `CHANGES-v0.1.md` documenting W1–W6 with the same Added/Deferred/Risk-residual structure as wave-13's closeout. Update `IMPLEMENTATION-PLAN.md` §1.1 status snapshot with the wave-14 entry. Mirror wave-12/13 closeout style.

---

## Operational backfill (post-deploy on the design-partner deployment)

These are runbook operations on a running deployment — NOT code changes. They run AFTER W1 merges, `0.1.0-a.9` is tagged, and the new image is pulled on `<partner-box-host>`. Decision: no manual SQL on prod during wave-14 development. Once `0.1.0-a.9` deploys, the operator runs the SQL UPDATE below as a planned deployment-runbook step (or uses the UI's PATCH `allowed_paths` surface — same effect, same audit trail). The bare-summary heartbeat persists on the partner deployment for ~2–3 more days during dev — acceptable since the chain itself is verified end-to-end.

1. **Backfill `allowed_paths` for the existing bindings** (per-adapter defaults from W1). Either click through the new Edit affordance in `SourceBindingDetail` for each binding, or run a one-shot SQL via the deployment runbook. Scope by domain explicitly so multi-domain deployments don't over-update — substitute `<slug>` for the target domain (e.g. `wiki-<domain>`):
   ```sql
   -- substitute <slug> for the target domain (e.g. wiki-<domain>)
   UPDATE sources_bindings b SET allowed_paths = ARRAY['meetings/**','transcripts/**','docs/**']
     FROM domains d
     WHERE b.domain_id = d.id
       AND d.slug = '<slug>'
       AND b.adapter_slug = 'drive'
       AND b.allowed_paths = '{}';

   UPDATE sources_bindings b SET allowed_paths = ARRAY['projects/**','tasks/**']
     FROM domains d
     WHERE b.domain_id = d.id
       AND d.slug = '<slug>'
       AND b.adapter_slug = 'asana'
       AND b.allowed_paths = '{}';

   -- repeat per binding adapter present (fireflies → ['meetings/**'],
   -- n8n → ['workflows/**']) using the per-adapter defaults
   ```
2. **Re-enqueue the failed jobs** via the new "Retry failed jobs (N)" button on each binding's detail page (W2), or via `POST /api/admin/source-bindings/:id/retry-failed`.
3. **Wait for the compile pipeline** to drain: monitor `ingestion_intake` rows moving `pending → classified`; expect roughly 5–30 min for a few hundred docs through Worker classify + Thinker compile.
4. **Trigger worldview recompile**: hit `POST /api/admin/domains/wiki-<domain>/recompile-worldview` (the wave-13 W1 endpoint). Verify `worldview.md` body grows from the ~171-byte placeholder to a multi-KB synthesis.
5. **Re-fire heartbeat** via Activity → Pipelines → Run now. Verify the resulting Asana task:
   - Title shape: `[COO] Raport -- YYYY-MM-DD`.
   - Due-date: today (per `due_date_policy: "today"`).
   - Assignee: whatever the channel config has set, if any.
   - Body lead: `<h1>summary</h1>` followed by per-alert `<h2>` sections drawn from real wiki content + system-health context.

---

## Verification

### Per-PR gates (every PR before merge)

- `pnpm lint && pnpm typecheck && pnpm test` green at root.
- `THREAT-MODEL.md` §5 PR checklist run.
- GitHub Copilot inline triage cleared.
- Spec reviewer approval + code-quality reviewer approval.
- New tests pin the new behavior (see per-PR test bullets above; TDD per `CONVENTIONS.md` §3).

### Wave-end gate (against a fresh deploy of `0.1.0-a.9`)

1. Pull the new image, restart compose, verify clean boot + migrations applied + `intake_status` enum now includes `failed`.
2. Open Sources tab → each binding's detail → verify `allowed_paths` chip list visible and editable.
3. Backfill `allowed_paths` via PATCH UI or one-shot SQL (operational step above).
4. Hit "Retry failed jobs (N)" — verify all N jobs re-enqueue, no new failures spike on the BullMQ failed set.
5. Watch `ingestion_intake` rows move `pending → classified` over 5–30 min.
6. Hit `POST /api/admin/domains/wiki-<domain>/recompile-worldview` — verify the worldview body grows substantially (>5KB) vs the prior placeholder.
7. Hit Heartbeat "Run now" — verify the Asana task:
   - Title: `[COO] Raport -- YYYY-MM-DD`.
   - Due-date: today.
   - Assignee: per channel config (if set).
   - `html_notes` lead: `<h1>summary</h1>` then per-alert `<h2>` blocks.
   - Content: real synthesis (not worldview placeholder).
8. Force-fire heartbeat on an EMPTY domain (create a fresh test domain, no docs) — verify the heartbeat surfaces operational-health alerts (binding count, intake counts) rather than placeholder text. This proves W6's empty-wiki branch works.
9. THREAT-MODEL §5 maintainer walk against the wave-14 closing commit.

---

## Out of scope (explicit, defer)

- **Slack / Email output adapters.** Same v0.2 deferral as wave-13. W5's transformer pattern is the template for either.
- **Per-channel Mustache / Liquid templates.** First-party code-owned transformers stay the model. W5's channel-config knobs are bounded options, not free-form templating.
- **Wiki-content lint surfacing in heartbeat.** Wave-14 adds operational health; a "wiki lint findings" tile is a v0.2 nicety once the Lint agent runs reliably.
- **Cross-domain `company.md` heartbeat.** `architecture.md` §9 mentions multi-domain aggregation; today the partner runs single-domain. Defer to v0.2.
- **Webhook-receiver intake error path.** The webhook receiver already DLQs to `ingestion.intake.dlq` with structured errors; W3 covers the compile-worker only. Webhook DLQ consumer is a v0.2 follow-up.
- **Heartbeat surfacer-style suggestions.** The Surfacer agent does this; heartbeat stays focused on briefing + operational health.
- **Pre-fetched `allowed_paths` validation against real wiki paths.** The runtime page-guard already validates emitted paths; v0.2 could add a "test paths" preview step to the binding-create UI.

---

## Reuse — call these, do not reinvent

- `assertBindingNotWildcardOnly` + `BindingConfigError` (`packages/engine-ingestion/src/classifier/binding-guard.ts`) — re-export and call from the admin-API POST/PATCH in W1.
- BullMQ Queue handle + failed-set `ZRANGE` pattern (`packages/engine-ingestion/src/queue.ts`) — W2 enumerator.
- `OpencooError.kind` → `error_class` enum mapping (`@opencoo/shared/errors`) — W3 catch.
- `spotlight()` + `loadPrompt()` from `@opencoo/shared` — W6 prompt assembly.
- `escapeHtml()` from `packages/cli/src/provision/output-transformers.ts` — W5 title/body rewrite only (W5 lives in `cli/`, same package). W4 (UI) uses React text rendering; W6 (engine-self-operating) emits plain text into the LLM prompt envelope and lets W5's transformer escape downstream when rendering to Asana `html_notes`. If a shared escape is ever required, lift it into `@opencoo/shared` first.
- PATCH-with-CSRF + admin-team + audit-write-before-mutate pattern from wave-13 W2 `PATCH /api/admin/agent-instances/:id`.
- "Scan now" + cooldown UI pattern from wave-12 Z3 — W2 "Retry failed jobs" button.
- `SourceBindingDetail` panel pattern — extend, don't rebuild (W1 + W4).
- Dynamic schema-driven channel-config form rendering (`NewOutputChannelModal.tsx`) — W5 new fields render with no UI code changes.
- `assertDomainSlugInScope` from the agent harness — W6 scope check before reading intake/binding state.

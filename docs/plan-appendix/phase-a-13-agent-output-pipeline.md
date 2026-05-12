# Phase-a appendix #13 — agent-output pipeline + worldview compiler

> **Status:** scoping doc landing as PR-W0; W1–W4 follow.
> **Wave shape:** 4 PRs across 2 sub-waves (W1 + W2 parallel; W3 + W4 after).
> **Predecessor:** wave-12 (phase-a appendix #12) closed source-content ingestion gaps; this wave closes the agent-output gaps that block opencoo from producing + delivering an autonomous daily report.

---

## Context

Wave-12 shipped on `0.1.0-a.4`. Live verification against the partner cutover at `https://opencoo.aiservices.pl/` confirmed all 15 wave-12 gaps closed empirically:

- 260 documents seeded across 7 source bindings (5 Asana × 38 + 2 Drive × 35).
- `scanner.scan_now` + cron registered + dispatched.
- Cursor preserved across webhook-driven scan() returns (Z2 cursor-preserve fix-up).
- Drive credential wrapper unwrap working (Y2 hotfix).
- Output-channel registry instantiated, schema migrated (`output_channels` table), Outputs UI tab visible.
- `_FILE` env-suffix supported in both engine + gitea-wiki-mcp-server.
- GHCR images flipped public on tag (Z8's `make-public` job).

But the daily-report flow remained dead at the partner. The 08:00 UTC heartbeat dispatch on 2026-05-12 failed:

```
agent_runs.body_failed
  definition_slug=heartbeat
  error_class=validation
  error=mcp-tool-client: resource 'worldview://wiki-estyl-pilot' not found
```

And `agent_instances.output_channel_ids = []` on heartbeat — even with a working compile pipeline, there'd be nothing to deliver to.

Investigation surfaced **three concrete gaps in opencoo itself** (not migration-specific):

1. **G1 — Worldview compiler exists but isn't called.** `compileDomainWorldview` at `packages/engine-self-operating/src/pipelines/worldview/compile-domain.ts:67` is fully implemented + tested. Zero production callers. The ingestion compiler emits `Worldview-Impact: high|medium|low` git trailers on every commit per architecture.md §9.4 — but nothing reads them to schedule a recompile. The pre-Z5 partner domain doesn't even have the placeholder.

2. **G2 — No agent-instance → output-channel binding surface.** The `output_channel_ids` jsonb column (array stored as JSON) on `agent_instances` exists, the dispatcher's post-run `dispatchDeliveries` correctly iterates it (Z4), but there's no UI or admin-API to populate the array. Operator has no path to bind a channel to heartbeat.

3. **G3 — `output-webhook` not registered in composition.** Package is built + has extensive test coverage pinning HMAC-SHA256 signing, deterministic delivery IDs, exponential backoff, append-only audit, no-secret-leak. Production composition registers `output-asana` only. One missing `tryLoadAdapter` block blocks n8n drop-in.

This wave closes those three gaps + ships the per-(agent, adapter) transformers needed to render heartbeat output as a pretty Asana task body (Asana doesn't render markdown — requires `html_notes` with a restricted HTML tag whitelist).

---

## Gap inventory

### CRITICAL — blocks the autonomous daily-report flow

**G1** — No worldview compiler triggered in production. Heartbeat/lint/surfacer all hard-fail on empty domains; populated domains never see worldview synthesis without it.

**G2** — No agent-instance → output-channel binding UI + admin-API. Dispatcher correctly iterates `output_channel_ids` but the array is always empty.

**G3** — `output-webhook` not registered in composition. Adapter is production-ready; composition is missing one block.

### Operational backfills (one-shot during 0.1.0-a.5 deployment)

**B1** — Existing `wiki-estyl-pilot` domain lacks `worldview.md` (created on 0.1.0-a.1, pre-Z5). Operator hits the new "Recompile worldview" endpoint once.

**B2** — Partner heartbeat has no output channel. Operator creates an `output-asana` channel via the Outputs UI + binds it via the new Agents UI tab.

---

## PR roster + sequencing

### Sub-wave 1 — agent-output binding (parallel-safe)

- **PR-W1** — Worldview compiler wiring. New BullMQ worker + trailer-poll pipeline + safety-net cron + recompile-worldview admin endpoint + UI button. ~450 LOC.
- **PR-W2** — Agent-instance output-binding UI + admin-API + per-(agent, adapter) transformers. New `PATCH /api/admin/agent-instances/:id` + `AgentInstanceDetail.tsx` + `Agents.tsx` + `output-transformers.ts` emitting Asana `html_notes`. Extend `output-asana` `payload-schema.ts` to accept `htmlNotes` (mutually exclusive with `notes`). ~400 LOC.

### Sub-wave 2 — automation reach + closeout

- **PR-W3** — Wire `output-webhook` in composition. One `tryLoadAdapter` block + descriptor map entry + composition test + runbook §13 n8n setup. ~60 LOC.
- **PR-W4** — Wave-13 closeout addendum. CHANGES-v0.1.md wave-13 section + IMPLEMENTATION-PLAN.md §1.1 update.

**Sequencing notes:** W1 + W2 parallel-safe (different files except `audit-log.ts` allow-list — sequential within one merge tick). W3 depends on W2's composition refactor (`mergePayloadFor` dispatcher) — merge W2 first.

---

## Asana adapter quirks (load-bearing for W2)

Sourced from the Asana OpenAPI spec + developers.asana.com/docs/{rich-text,rate-limits}:

- **`notes` vs `html_notes` are mutually exclusive** on `POST /tasks`. Sending both → 400. W2 transformers emit `html_notes` only for the pretty path; raw `notes` JSON fallback only for unknown-agent dispatches.
- **Markdown is NOT rendered.** Pretty output ONLY via `html_notes` with Asana's restricted tag whitelist: `<body>` (required root) · `<strong> <em> <u> <s> <code>` · `<ol> <ul> <li>` · `<a> <blockquote> <pre>` · `<h1> <h2> <hr/> <img> <table> <tr> <td>`. **Only `<a>` accepts attributes**; others must be bare. Invalid XML → 400.
- **HTML nesting limits**: headers/blockquotes/`<pre>` cannot live inside `<li>`; lists cannot live inside headers/blockquotes/`<pre>`. The `heartbeatToAsana` transformer must structure `<h2>` and `<ul>` as siblings.
- **Due dates mutually exclusive**: `due_at` (ISO UTC) and `due_on` (YYYY-MM-DD local) cannot both be set. v0.1 transformers don't set due — channel-config knob is v0.2.
- **Workspace inference**: omit `workspace` when `projects: [projectGid]` is present.
- **Task name limit ~1024 chars**; existing transformer slices to 500 (display-list safe).
- **Rate limits**: 150/min free, 1500/min paid (per token). Concurrent: 50 GET, 15 POST/PUT/PATCH/DELETE. 429 with `Retry-After`. Output-asana adapter already surfaces 429 via `AsanaApiHttpError.retryAfterSeconds`; dispatcher retries are BullMQ's per-job backoff.
- **Cost-based throttling** exists beyond req/min — expensive graph traversals can trigger 429 unrelated to rate. Runbook flag.
- **Concurrent-write cap (15)**: dispatcher already runs deliveries sequentially per-run (Z4); keep that semantic.
- **PAT scope**: full-scope only; no narrowing. CredentialStore-encrypted at rest is the only mitigation.

---

## Worldview compiler cadence (load-bearing for W1)

Per the internal architecture spec at `architecture.md` §9.4 (gitignored; public contributors see `docs/ARCHITECTURE.md` per CLAUDE.md's repo-state note):

| Trigger | Debounce / threshold | Action |
|---|---|---|
| `Worldview-Impact: high` commit | 15 min batch window | Recompile `worldview.md` |
| `Worldview-Impact: medium` commits | ≥3 accumulated OR 24 h age | Recompile `worldview.md` |
| `Worldview-Impact: low` commits | — | Never trigger alone |
| Daily safety-net | Every 24 h at quiet hour | Refresh `as_of`; no-op if nothing material |

The trigger is **per-domain batch** (not per-page). The ingestion compiler already emits `Worldview-Impact` trailers on every page-write commit — W1 only wires the consumer.

---

## Deployment steps (after all 4 PRs merge)

1. Cut `0.1.0-a.5` tag. Release workflow builds both GHCR images + flips them public (Z8).
2. Pull on partner box; restart `opencoo` + `gitea-wiki-mcp-server`. Verify clean boot + `scheduler.refreshed registered:3` + the new worldview safety-net cron registered.
3. **B1** — `POST /api/admin/domains/wiki-estyl-pilot/recompile-worldview` (manual trigger). Verify worker writes real synthesised `worldview.md` (not placeholder) into the Gitea repo.
4. **B2** — Create one `output-asana` channel via the Outputs UI (PAT credential + partner's daily-report project gid). Bind it to heartbeat via the new Agents UI.
5. Force-fire heartbeat. Verify the Asana task lands with `html_notes`-rendered per-alert sections.
6. Optional: create an `output-webhook` channel pointing at n8n's webhook trigger URL with a shared signing secret. Bind to surfacer. Force-fire. Verify n8n receives valid HMAC-signed request.
7. THREAT-MODEL §5 maintainer walk against the wave-13 closing commit.

---

## Out of scope (deferred)

- `output-slack` / `output-email` adapters (not built; v0.2).
- Per-channel formatting templates (Mustache/Liquid) — code-owned first-party transformers in W2 are the v0.1 shape.
- `worldview_compiles` audit table — rely on commit trailer + BullMQ worker log.
- Cross-domain `company.md` aggregator (architecture.md §9.5; v0.2).
- Heartbeat delivery transactionality (best-effort per Z4; v0.2 may add per-binding retry config).

---

## Entry conditions

| | Status |
|---|---|
| Wave-12 closure | ✅ merged + `0.1.0-a.4` live |
| Y1 + Y2 hotfixes | ✅ merged |
| Partner box | running `0.1.0-a.4`, healthy |
| Source ingestion | 260 docs in intake, 7 bindings cursored |
| Compile pipeline | guard pre-pass runs; needs worldview compiler to advance |
| Heartbeat dispatch | fires daily 08:00 UTC, fails on missing worldview |
| Output channels | infrastructure shipped (Z4); needs UI binding (W2) + W3 plumbing |

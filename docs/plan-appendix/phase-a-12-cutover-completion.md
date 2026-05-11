# Phase-a appendix #12 — partner-cutover completion (make Estyl's deployment actually compile pages)

> **Status:** 🚧 in flight · planned 2026-05-11 · 9 PRs (Z1–Z9) across 3 sub-waves · scoping doc lands as Z0 of the wave (this file).
> Read after `docs/plan-appendix/phase-a-11-pilot-cutover-hardening.md` (closed wave) and the Estyl deployment journal (private; lives in `docs/local/deployments/estyl-pilot-2026-05-11.md`).

---

## Why this exists

The first real partner cutover (Estyl, 2026-05-11) stood up the full opencoo stack on a Hetzner box at `https://opencoo.aiservices.pl/` against the freshly-cut `0.1.0-a.1` GHCR image. Stack came up healthy; provisioning succeeded for 1 domain (`wiki-estyl-pilot`, locale `pl`), 7 source bindings (2 Drive + 5 Asana), 3 scheduled agents (heartbeat/lint/surfacer), and the auxiliary MCP servers (gitea-wiki-mcp + n8n-mcp).

Then we tried to actually ingest content.

**Nothing landed in the wiki.** The 5 Asana webhook handshakes succeeded (`signature_ok=true`), but no events fire from idle projects. A manual force-trigger of the scanner produced this:

```
scanner.scan_failed adapter_slug=drive
  error: drive: production makeDrive not wired in v0.1 — bind via UI when adapter ships
```

Investigation surfaced **15 distinct gaps** between what the engine *claims* to support (per the runbook + the admin-API schema responses) and what it *actually does* in the shipped image. The most consequential: opencoo has **no seed/backfill primitive** — when the operator binds a Drive folder or an Asana project, the engine doesn't pull the existing content. Everything is incremental-from-now-forward, which means a brand-new domain stays empty until partners happen to make new changes, and even then Drive doesn't work at all because the production client wiring is stubbed out.

This wave (#12) closes every gap that blocks the partner from seeing real wiki pages compiled from their data, plus the operator-UX completers and documented polish items.

---

## Gap inventory (15 items, categorized by severity)

### CRITICAL — blocks any compiled wiki page (Estyl can't use opencoo until these merge)

**G1 · `makeDrive` is a runtime stub.** `packages/cli/src/provision/production-composition.ts:427-429` explicitly throws `"drive: production makeDrive not wired in v0.1 — bind via UI when adapter ships"`. The `googleapis` npm package isn't in `pnpm-lock.yaml` at all (verified). The `MakeDrive = (refreshToken: Buffer) => DriveLikeApi` factory shape is defined at `packages/source-drive/src/adapter.ts:45`; the mock satisfies it; production needs a real `googleapis@>=144` Drive client wrapped to that shape.

**G2 · No seed/backfill primitive on `SourceAdapter`.** The interface at `packages/shared/src/source-adapter/index.ts:261-273` only exposes `scan(SourceScanArgs)` (incremental polling, cursor-keyed) + optional `webhook` helpers. Brand-new bindings sync forward from the moment they're created — Drive's existing files and Asana's existing tasks are invisible until they change. No `seed()` / `backfill()` / `bootstrap()` method exists anywhere.

**G3 · No scanner cron registration.** Polling-mode adapters need a periodic call. `packages/engine-ingestion/src/workers/index.ts:192` constructs the worker but no code anywhere registers a BullMQ repeat job for `ingestion.scanner`. Only the 3 scheduled agents (heartbeat/lint/surfacer) get repeat-job entries via `packages/engine-self-operating/src/scheduler/agent-dispatcher.ts:286-293`. Drive + n8n bindings never tick. Verified at runtime: `bull:ingestion.scanner:repeat` doesn't exist in Redis on Estyl's box.

**G4 · `worldview.md` not seeded on domain create.** Engine creates a Gitea repo seeded with `index.md` + `log.md` + `schema.md` (24 bytes total), no worldview. The Heartbeat agent reads `worldview://<slug>` via `gitea-wiki-mcp-server` (`packages/gitea-wiki-mcp-server/src/resources/worldview.ts:68-122`) which returns `McpResourceNotFoundError` on missing file. Verified: every Heartbeat dispatch on the new Estyl domain fails with `error_class=validation, output={"name":"McpResourceNotFoundError"}`.

**G5 · `OutputChannelRegistry` never instantiated.** The interface + the `output-asana` package both exist (`packages/shared/src/output-adapter/interface.ts:83-88`, `packages/adapters/output-asana/src/adapter.ts`). `OutputChannelRegistry.register(adapter)` is defined at `packages/engine-self-operating/src/output-channels/registry.ts:49-96`. But `production-composition.ts` never instantiates it; grep `new OutputChannelRegistry` returns zero hits. Heartbeat stores `output_channel_ids` on `agent_instances` (writable per `packages/engine-self-operating/src/agent-harness/instances.ts:149-151`) but at dispatch time there's no registry to deliver through. Daily-report-to-Asana isn't a "v1.x feature" — it's 90% built and not wired.

### IMPORTANT — operator hits these on every new binding / agent

**G6 · No post-binding-create initial-scan trigger.** `packages/engine-self-operating/src/admin-api/routes/source-bindings.ts:252-431` POST handler INSERTs the row + writes audit, then returns 201. No enqueue of a scan job. Combined with G3, this means a freshly-bound Drive folder sits forever until G3 adds the cron AND G2 adds the seed.

**G7 · Scheduler doesn't re-enumerate after `agents seed`.** `packages/engine-self-operating/src/scheduler/agent-dispatcher.ts:191-252` only enumerates `agent_instances` at boot. `packages/cli/src/commands/agents-seed.ts:212-228` INSERTs rows but has no post-insert hook. Operator runs `opencoo agents seed` after engine boot → seeded instances are invisible until `docker compose restart opencoo`. (Verified live on Estyl box; took 1 round trip to discover.)

**G8 · No "Run now" for the scanner per binding.** PR-R3 added "Run now" for the 3 scheduled agents (heartbeat/lint/surfacer) but the scanner has no equivalent admin-API surface. Operator wanting to verify a Drive binding works has to either wait 4h for the cron OR shell into the box and add a BullMQ job manually (which is what we did during the Estyl deployment).

### POLISH — slow operator iteration but doesn't block

**G9 · `gitea-wiki-mcp-server` doesn't honor `_FILE` env-suffix.** Engine + Gitea + n8n-mcp all support it; this one doesn't. Operator has to stand up an extra `.env.gitea-wiki-mcp` file populated from the secret files.

**G10 · `REPOS` env doesn't auto-derive from opencoo's domain registry.** Operator-maintained JSON array. Should be derivable from `domains` table OR pushed via `/refresh/:slug` ping when a domain is created.

**G11 · GHCR images private by default.** First-time partner pull fails with `unauthorized` until visibility is flipped via `gh api -X PATCH /user/packages/container/<name> -f visibility=public` OR a Personal Access Token is set up.

**G12 · New-domain dialog stale-closure swap bug.** When external scripts (1Password, Bitwarden, JS-set bypass) manipulate the SLUG/DISPLAY-NAME inputs, React swaps field values on the next render. Reproduced live on Estyl.

**G13 · `bin/opencoo-bootstrap-host.sh` missing.** UFW + fail2ban + unattended-upgrades + opencoo user + sshd lockdown — every partner needs the same hardening sequence. Should be one idempotent script.

**G14 · `bin/opencoo-gitea-bootstrap.sh` missing.** 4 separate API calls + a CLI invocation to set up admin user + PAT + org + team + membership. Each can fail silently in a heredoc (and did during Estyl).

**G15 · Compose secrets default mode + restart-doesn't-pick-up-env-file gotchas.** Worth a runbook callout.

---

## Wave-12 PR roster + sequencing (9 PRs across 3 sub-waves)

### Sub-wave 1 — make Drive + the seed primitive actually work

| PR | Title | Branch | Closes |
|---|---|---|---|
| Z1 | Real `googleapis` Drive client wiring (CRITICAL) | `phase-a-appendix-12/z1-drive-googleapis` | G1 |
| Z2 | `SourceAdapter.seed()` primitive + Drive seed + Asana seed (CRITICAL) | `phase-a-appendix-12/z2-seed-primitive` | G2 |
| Z3 | Scanner cron + per-binding "Scan now" admin endpoint (CRITICAL) | `phase-a-appendix-12/z3-scanner-cron-and-runnow` | G3, G6, G8 |

**Order:** Z1 first (adds `googleapis` to lockfile); Z2 + Z3 parallel after.

### Sub-wave 2 — output adapters + worldview seed

| PR | Title | Branch | Closes |
|---|---|---|---|
| Z4 | Wire `OutputChannelRegistry` + register `output-asana` (CRITICAL) | `phase-a-appendix-12/z4-output-channels` | G5 |
| Z5 | Empty `worldview.md` seeded on domain create | `phase-a-appendix-12/z5-worldview-seed` | G4 |

**Order:** parallel after sub-wave 1 merges.

### Sub-wave 3 — operator quality-of-life + polish

| PR | Title | Branch | Closes |
|---|---|---|---|
| Z6 | Scheduler periodic re-enumerate | `phase-a-appendix-12/z6-scheduler-refresh` | G7 |
| Z7 | `bin/opencoo-bootstrap-host.sh` + `bin/opencoo-gitea-bootstrap.sh` | `phase-a-appendix-12/z7-bootstrap-scripts` | G13, G14 |
| Z8 | `_FILE` in mcp-server + `REPOS` auto-derive + GHCR public + runbook gotchas | `phase-a-appendix-12/z8-polish-bundle` | G9, G10, G11, G15 |
| Z9 | NewDomainModal stale-closure fix | `phase-a-appendix-12/z9-new-domain-dialog-fix` | G12 |

**Order:** all four fully parallel-safe; merge any order after sub-wave 2.

---

## File overlap map

| File | PR | Notes |
|---|---|---|
| `packages/source-drive/package.json` | Z1 | + googleapis dep |
| `packages/source-drive/src/google-drive-api.ts` | Z1 (NEW) | real Drive client |
| `packages/cli/src/provision/production-composition.ts` | Z1 (replace throw) + Z3 (cron) + Z4 (output registry) | three sub-waves overlap; serialise rebases |
| `packages/shared/src/source-adapter/index.ts` | Z2 | `seed?` to interface |
| `packages/source-drive/src/adapter.ts` | Z2 | implement `seed` |
| `packages/adapters/source-asana/src/adapter.ts` | Z2 | implement `seed` |
| `packages/engine-ingestion/src/pipelines/scanner.ts` | Z2 + Z3 | both touch the scanner; serialise |
| `packages/engine-self-operating/src/admin-api/routes/source-bindings.ts` | Z3 | initial-scan + scan-now endpoint |
| `packages/engine-self-operating/src/output-channels/registry.ts` | Z4 | composition wiring |
| `packages/adapters/output-asana/src/adapter.ts` | Z4 | touch only if needs polish |
| `packages/engine-self-operating/src/admin-api/routes/domains.ts` | Z5 | + `worldview.md` seed |
| `packages/engine-self-operating/src/scheduler/agent-dispatcher.ts` | Z6 | extract `refresh()` + setInterval |
| `bin/opencoo-bootstrap-host.sh` | Z7 (NEW) | host hardening |
| `bin/opencoo-gitea-bootstrap.sh` | Z7 (NEW) | gitea bootstrap |
| `packages/gitea-wiki-mcp-server/src/config.ts` | Z8 | `_FILE` support |
| `.github/workflows/release-image.yml` | Z8 | GHCR-public step |
| `docs/pilot-runbook.md` | Z8 | §11 callouts |
| `packages/ui/src/components/NewDomainModal.tsx` | Z9 | uncontrolled inputs |

**`production-composition.ts` overlap (Z1 → Z3 → Z4):** each PR rebases on the previous as it lands; main-thread does the rebase resolution in a 3-line conflict (new code adds at distinct sections of the same file).

---

## Reuse — call these, do not reinvent

- `MakeDrive` factory shape (`packages/source-drive/src/adapter.ts:45`) — Z1's real client must satisfy this.
- `makeMockDrive` (`packages/source-drive/src/testing/mock-drive.ts:61-106`) — Z1 mirrors the surface.
- `SourceScanResult` shape (`packages/shared/src/source-adapter/index.ts:57-66`) — Z2's `SourceSeedResult` reuses it.
- `runScanner` intake pipeline (`packages/engine-ingestion/src/pipelines/scanner.ts:117-200`) — Z2's seed flows through the same dedupe + enqueue path.
- `agent-dispatcher.ts:286-293` BullMQ `repeat:` pattern — Z3's scanner cron mirrors it.
- `OutputChannelRegistry.register()` (`packages/engine-self-operating/src/output-channels/registry.ts:49-96`) — Z4 instantiates + calls.
- `output-asana` adapter (`packages/adapters/output-asana/src/adapter.ts`) — Z4 registers as-is.
- existing `wikiWrite` for the 3 seed files in domain-create — Z5 adds a 4th call.
- `engine-scaffold/config.ts:53-67` `readWithFile` helper — Z8 mirrors in gitea-wiki-mcp-server.
- `CredentialForm.tsx` uncontrolled-inputs pattern (PR-Q11) — Z9 mirrors for NewDomainModal.

---

## Verification per PR + overall

**Per-PR gates** (every PR before merge):

- `pnpm lint && pnpm typecheck && pnpm test` green at root
- New tests pin the new behavior:
  - **Z1**: real-Drive integration test gated on `RUN_REAL_DRIVE=1`
  - **Z2**: per-adapter `seed()` tests + intake-pipeline integration
  - **Z3**: composition test asserting cron registered + new admin endpoint test
  - **Z4**: output dispatch end-to-end test with mocked Asana
  - **Z5**: domain-create asserts 4 wiki files
  - **Z6**: dispatcher refresh test with seeded post-boot instance
  - **Z7**: shell-script idempotency tests
  - **Z8**: per-fix regression tests
  - **Z9**: stale-closure swap regression test
- THREAT-MODEL §5 PR checklist run + linked
- Copilot inline triage cleared
- Chrome QA before/after pair attached for UI-visible PRs (Z3, Z4, Z9)
- Spec reviewer ✅ + code-quality reviewer approved

**Wave-end gate** (against the **live Estyl deployment**, not the local dev box):

- Cut `0.1.0-a.2` tag → release-image.yml builds + pushes
- Pull `0.1.0-a.2` image on `opencoo.aiservices.pl` → restart compose → verify clean boot
- Click "Scan now" on a Drive binding (Z3 button) → ≥1 page lands in `estyl/wiki-estyl-pilot` Gitea repo within 60s (Drive seed via Z1 + Z2 fires)
- Click "Scan now" on an Asana binding → ≥1 page lands within 60s (Asana seed via Z2 fires)
- Force-fire Heartbeat → no `worldview://...not found` (Z5 placeholder), output lands as a task in the daily-report Asana project (Z4 wires output-asana)
- Seed a test agent post-boot → registered within 60s without restart (Z6 refresh)
- The 4h scanner cron has fired at least once after deploying — visible in `bull:ingestion.scanner:repeat`
- THREAT-MODEL §5 maintainer walk against the wave-12 closing commit

---

## Out of scope (explicit, defer)

- **Per-source `seed` cadence rate-limiting / pause-resume** — Z2 ships unbounded pagination. For Estyl's 2 small Drive folders + 5 Asana projects, this is fine. v0.2 may add a "pause seed" UI button if any partner has a 100k-task project.
- **Output adapter for Slack / Email** — Z4 ships `output-asana` only. Slack + Email packages are stubs (verify via grep `packages/output-slack`, `packages/output-email`); their composition wiring is identical-pattern but defer to v0.2.
- **`source-n8n` real client wiring** — n8n adapter is the same stub-throw pattern as Drive. Estyl doesn't need n8n as a SOURCE (they use n8n as automation, consumed via `n8n-mcp`). Filed as v1.x scope.
- **Worldview AUTOMATIC compile after first ingest** — Z5 seeds a placeholder; the existing compiler overwrites it on the first ingest cycle. If a partner deploys the engine but never ingests, Heartbeat shows the placeholder forever. That's correct behavior; not a bug.
- **`/api/admin/source-bindings/:id/scan-now` cap or backpressure** — Z3 ships unbounded; operator can DoS the scanner by spamming the button. v0.2 can add a per-binding cooldown.

---

## Process notes

Same agent-team workflow as appendices #4–#11. Coordinator (main thread) → Implementer (`general-purpose` subagent in `git worktree add` isolation) → Spec reviewer → Optional code-simplifier (PRs >200 lines) → Code-quality reviewer (`superpowers:code-reviewer`) → Chrome QA (mandatory per PR for any UI-visible change) → Copilot triage → merge.

**Concurrency rule** (per appendices #9–#11): implementer subagents NEVER share a worktree; locale-file conflicts handled by namespace discipline + main-thread merge resolution where required.

**Wave-end Chrome QA** drives against the live Estyl deployment (per appendix #11's lesson: wave-end QA against the running engine is the only check that catches operator-perceptible regressions). Local dev box still gets per-PR Chrome QA before reviewer dispatch.

---

## Pre-flight checks before Z1 dispatches

1. Wave-11 closeout merged + `0.1.0-a.1` tag cut + image live on GHCR ✓ already done.
2. Local `main` rebased; `pnpm install && pnpm build && pnpm test` green at root.
3. Estyl Hetzner box (`opencoo@167.235.240.200`) has SSH access from operator's `~/.ssh/id_ed25519` (verified during the deployment journal).
4. Operator confirmed acceptance of `googleapis@^144` as a new dependency in `packages/source-drive/` (it pulls a chunky transitive tree — adds ~10 MB to the engine image). Captured 2026-05-11.

---

## Estimated scope

~30–40 hours subagent-driven work across 9 PRs / 3 sub-waves. Roughly 2× the size of wave-11 because the seed primitive + output channels + Drive client are all genuinely-new product surface, not just hardening. Z1 alone is the largest single PR (real Google Drive client wiring is ~250 lines + new dep).

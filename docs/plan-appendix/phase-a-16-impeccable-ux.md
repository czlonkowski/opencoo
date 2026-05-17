# Phase-a appendix #16 — Wave-16 · Impeccable UX

> **Status:** scoping doc lands as PR-WZ0; sub-waves A + B + C follow across ~23 implementation PRs in 5 phases.
> **Wave shape:** A (Accessibility foundation, 7 PRs) · B (Workflow + perceived-performance + onboarding, 8 PRs) · C (Visual polish + locale completeness + in-app help, 8 PRs).
> **Predecessor:** wave-15 (`docs/plan-appendix/phase-a-15-management-ui-completeness.md`) closed `0.1.0-a.13.*`. Every operator-editable schema column has a UI surface, the Prompts tab is a real editor, Reports has a precondition-diagnostic empty state, the sidebar carries Operate/Knowledge/Governance/Diagnostics groups + Cmd-K palette, and the W11 audit confirmed zero design-system hard-no violations. Wave-16 ships as `0.1.0-a.14.*`.

---

## Context

Wave-15 made the box **complete**; wave-16 makes it **impeccable**. The difference is between "operator can do the job through the UI" and "operator never thinks about the UI." Three orthogonal gaps converge.

**Accessibility floor.** A Chrome-driven QA pass against the partner deployment surfaced confirmed WCAG 2.2 AA failures on the only surface an unauthenticated agent can reach — the PAT-entry modal. Login carries zero `<h1>`, no landmark regions (`<main>`/`<nav>`/`<header>`/`<footer>`), and renders the dialog as `<div role="dialog">` rather than native `<dialog>`. The same shell pattern (`Modal.tsx:154-245`) lives behind every drill-down in the authenticated UI (~14 modals across the wave-15 surfaces), so a fix at the primitive layer ripples everywhere. Five routes (`Activity.tsx`, `Audit.tsx`, `Cost.tsx`, `Reports.tsx`, `Review.tsx`) ship without an `<h1>` at all. `Field.tsx:114-139` wires `aria-invalid` but the helper-text and error-text spans are visually-present-not-announced (no `aria-describedby` / `aria-errormessage` chain). For a regulated-industry adopter — the design partner's HR domain handles employee records under labor-law audit — a keyboard-only operator on a screen reader cannot do their job today. WCAG 2.2 AA is also the floor public-sector adopters require for procurement.

**Perceived-latency floor.** Loading state is a literal `t("common.loading")` string at 17 sites (every async-fetch surface — sweep `grep -rn "common.loading" packages/ui/src/`). On the partner deployment (~150–300 ms per admin-API call), the layout reshapes once data lands. There is no first-time setup wizard: a fresh deploy lands on an empty Domains list with no on-ramp from "PAT entered" to "first heartbeat lands in Reports." Every modal validates only at submit time (slug uniqueness round-trips as a 409). No optimistic UI: every PATCH does a full round-trip even for non-destructive flips. Vite ships one ~548 KB bundle on initial load. The W8 Reports diagnostic-panel pattern is the template for empty states but every other route still flat-renders "no rows" without context.

**Visual depth + locale floor.** The W11 audit certified zero hard-no violations (no gradients, no shadows, no pills, no emoji, no marketing voice, lowercase `opencoo`, mono-uppercase micro-labels, heartbeat-pulse the only loop) — strong baseline. But the UI is **flat-flat**. The `Instrument Serif` italic display family is loaded by `colors_and_type.css:14` and referenced **nowhere in v0.1 routes**; the `t-lede` class at line 158 is defined and unused. Every page leads with uniform Geist-500-40px `<h1>` so every surface feels like a directory. The Polish locale is structurally complete (`pl.json` is 922 lines vs `en.json`'s 921) but most strings under `pl.json` keys are still English text — earlier passes silently dropped `_todo_translate` markers without translating. There is no operator-controlled locale switcher in the TopBar (the comment at `lib/i18n.ts:11-12` is explicit). And ten years of agent-jargon — `review_mode`, `allowed_paths`, `scope_domain_ids`, `worldview_enabled`, `governance_cadence` — sit on the screen without point-of-use explanation; partial `help.*` strings exist in `en.json` but no `Tooltip.tsx` primitive renders them.

The three gaps don't share a single pattern — they share an **adopter consequence**. A regulated adopter rejects the product at procurement (accessibility). A new-operator partner abandons during the first hour (no onboarding, no skeleton, no live validation). A bilingual deployment ships in two locales but feels like one (Polish-as-machine-translation). Wave-16 closes all three with explicit interlock: B7 (toast queue) feeds A4 (live regions); A1 (native dialog) unblocks B6 (onboarding wizard) + every wave-15 modal; C2 (locale switcher) feeds C3 (PL pass) + C6 (density); A6 (contrast sweep) covers both density modes from C6. After wave-16 the UI passes axe-core's `serious`/`critical` set + a manual screen-reader walk, no layout shift on data arrival, every empty state names the next step, a fresh operator can go zero-to-heartbeat without leaving the chrome, every field validates as the operator types, every PATCH that's safe to optimistically apply does, every jargon term carries a focus-keyboard-reachable tooltip, Polish renders end-to-end, and the chrome carries strategic editorial typography on exactly three surfaces.

The user's framing: "impeccable UX of our opencoo. Test it thoroughly... multiple agents come to conclusions, discuss the conclusions and propose the way forward." Three Plan agents proposed sub-waves A/B/C from accessibility-first, workflow-first, and visual-first perspectives; the synthesis below sequences them as one coherent wave with foundation/consumer/verification phases.

---

## Wave roster

23 implementation PRs across 5 sequenced phases plus scoping + wave-end closeout. Sub-wave letters reflect topical grouping; the phase numbers below are the merge-train order.

### Phase 0 — Scoping (1 PR, serial)

- **WZ0** — this scoping doc, ported into the repo at `docs/plan-appendix/phase-a-16-impeccable-ux.md`. No code.

### Phase 1 — Foundation primitives (3 PRs, parallel)

Ship the three primitives every consumer composes on. All three independent.

- **A1** — `Modal.tsx` → native `<dialog>` + focus-trap + focus-return. Every existing modal consumer inherits without API change. `PatEntryModal.tsx` migrates onto the shared shell.
- **B1** — `Skeleton.tsx` primitive (composable rows: `Skeleton.Row mono cols={3}`, `Skeleton.Block`, `Skeleton.Field`). No animation loop (depth via border + paper-2). `useDeferredSkeleton` hook with 80ms render delay.
- **C1** — `Tooltip.tsx` primitive (floating-ui/react for collision detection; `?` trigger, no emoji, no fourth glyph) + `help.<term>` i18n namespace expansion. Lands wired to the 5 highest-traffic jargon terms (`reviewMode`, `allowedPaths`, `scopeDomainIds`, `worldviewEnabled`, `governanceCadence`).

### Phase 2 — Consumers, batch 1 (8 PRs, parallel)

Direct consumers of phase-1 primitives. Each is a different surface; no inter-dependency.

- **A2** — Semantic landmarks + `<h1>` coverage. `Chrome.tsx` emits `<header role="banner">` / `<nav aria-label>` / `<main aria-labelledby>` / `<footer role="contentinfo">`; sidebar groups become `<h2>`; active tab gets `aria-current="page"`. Five routes (Activity, Audit, Cost, Reports, Review) gain a single `<h1>`.
- **A3** — `Field.tsx` / `TextField.tsx` / `TextArea.tsx` ARIA-description coverage. `aria-describedby` for helper text; `aria-errormessage` + `aria-invalid` for error text. Same plumbing back-ported into `PatEntryModal.tsx`'s open-coded input.
- **B2** — Route-level code splitting via `React.lazy` + Suspense fallback = the matching B1 skeleton. Each sidebar entry prefetches its chunk on mouse-enter. `tests/ui/bundle-size.test.ts` asserts entry chunk `<200 KB`.
- **B3** — Empty-state template extension: extract `EmptyStatePanel` + per-route `use<Route>EmptyStateDiagnostics` hooks. Apply the W8 Reports diagnostic-chain pattern to Domains/Sources/Agents/Outputs/Activity/Review/Audit. Each empty state names the next step + provides a one-click CTA.
- **B7** — `Toast.tsx` queue + `useToast` hook (success/advisory/alert tones). Auto-dismiss with hover-pause, details-expand for full error body (mono pre-formatted, parsed 422 field-by-field). ARIA-live attributes wired (A4 builds on top); no emoji; tone via left-border color + JetBrains Mono tone-tag.
- **C2** — Locale switcher in `TopBar` (alongside username). Native `<select>` styled as `Btn variant="ghost"`. Persists in `localStorage.opencoo_locale` AND via `PATCH /api/admin/users/me/locale` (new endpoint + new `users.locale_preference TEXT CHECK (locale IN ('en','pl'))` column via additive migration 0015). Two-tier persistence: localStorage at session boot, DB hydration at login.
- **C4** — `<Display level={2}>` editorial-headline component (lints any other `var(--font-serif)` / `t-lede` / `Instrument Serif` reference). Three strategic placements ship together: Reports heartbeat lede, Prompts empty-state lede, Domains tab top-line summary.
- **C5** — Hover affordances pass on every clickable surface. Uniform pattern: 60ms `var(--ease-transform)`, background shift + border shift only (no shadow, no scale, no inversion). Transitions explicit per property, not `all`. Respects `prefers-reduced-motion: reduce`.

### Phase 3 — Consumers, batch 2 (7 PRs, parallel)

Layer on top of phase-2 surfaces.

- **A4** — Live regions + status announcements. Global `<div aria-live="polite" aria-atomic="true" id="opencoo-toast-region">` rendered once in `App.tsx`. `pushAnnouncement(text)` helper, 8s auto-remove. `role="status"` + `aria-live="polite"` on every B1 skeleton. `role="alert"` audit on every inline error site (~17 sites, fill ~4 gaps). B7's toast component wires its ARIA semantics through this region.
- **A5** — Keyboard navigation completeness. Cmd-K palette gets `role="combobox"` + listbox semantics (`aria-controls`, `aria-expanded`, `aria-activedescendant`, `<li role="option">` rows). Sidebar groups get roving-tabindex arrow-key navigation within group, arrow-left/right between groups (W3C APG menubar pattern, vertical adaptation). `SourceBindingDetail` + `AgentInstancePromptsSection` expandable-row chevrons audited as `<button>` with `aria-expanded`/`aria-controls`.
- **B4** — `useLiveValidation` hook + real-time validation in `NewDomainModal`, `NewSourceBindingModal`, `NewAgentInstanceModal`. Sync validators (regex, length, required) on every input event; async validators (slug-uniqueness, scope_domain_ids existence, cron-parser via the existing `SchedulerEditor.tsx:31` import) debounced 250 ms with per-field `AbortController`. Inline validation chips (mono micro-label, color-keyed) render via new `validationStatus` prop on `Field`. Uncontrolled-input pattern from PR-Z9 survives unchanged.
- **B5** — `useOptimisticPatch` hook + whitelist of safe PATCH branches. Whitelist: `agent_instances.{enabled,name,locale,scope_domain_ids}`, `output_channels.{enabled,name}`, `source_bindings.{enabled,notes,retention_days_override}`, `domains.{display_name,default_locale,worldview_enabled}`. Blacklist: sovereignty-token flows (prompt-override apply, LLM-policy apply), credential rotation, `memory_clear`, deletes. Saving-cue dot (one-shot 600ms `--ease-write` opacity fade, not a loop) + rollback-on-failure via B7 toast. Server's audit-write-before-mutate invariant preserved (client optimism doesn't weaken it).
- **B6** — `OnboardingWizard` inline strip on the Domains route when `domains.length === 0` and not previously dismissed. Four-step vertical stepper inside a single Card: create first domain → bind first source → seed first agent instance → wait for first heartbeat (polls `/api/admin/heartbeat/preconditions` already wired by W8). Skippable, persists dismissal in `localStorage.opencoo_onboarding_dismissed`; re-summonable via Cmd-K "Run onboarding wizard" entry.
- **C3** — Polish locale full pass. Audit every `pl.json` key against `en.json`; translate every English-bearing value via LLM (Claude); ship plural-form keys (`_one`/`_few`/`_many`/`_other` per i18next's Polish rules) for every count string. `tools/i18n-check.ts` script fails CI on English-looking strings under `pl.json` keys. Lift `formatUsd` (already locale-aware from W9) and add `formatDateTime` / `formatNumber` / `formatRelativeTime` to a new `packages/ui/src/lib/intl-format.ts`. **Native-Polish-speaker review scheduled as a separate post-wave-16 follow-up PR** (not a wave-16 gate per user direction).
- **C6** — Density toggle in TopBar (alongside locale). Two options (comfortable / compact); `useDensity()` hook reads `localStorage.opencoo_density` and writes `[data-density="compact"]` on `<body>`. CSS variables in `colors_and_type.css` get density-scoped overrides for `--row-pad-y`, `--table-cell-pad`, micro-label tracking. Cmd-K palette row height adapts.

### Phase 4 — Verification + measurement (4 PRs, parallel)

Wave-end gates and CI fences.

- **A6** — Color contrast sweep + skip-link. New `tests/accessibility/contrast.test.ts` parses `colors_and_type.css`, enumerates every foreground-on-background pair, asserts ≥4.5:1 (body, ≥14px) / ≥3:1 (large text + UI components) per WCAG 1.4.3 + 1.4.11. **Sweep iterates both density modes from C6.** Fail-the-build, not warn. Skip-link "Skip to content" renders first in `App.tsx`, links to `<main>`.
- **A7** — `@axe-core/playwright` CI job. Walks every route + every modal (programmatically opens each via Cmd-K) under both `en` and `pl`. Zero serious / critical issues required. Manual NVDA / VoiceOver walk checklist documented in `IMPLEMENTATION-PLAN.md` for the wave-end gate.
- **B8** — `performance.mark` / `performance.measure` pairs per route nav (`route:X:click` → `route:X:fetch-start` → `route:X:fetch-end`); chunk-load pair (`route:X:import-start` → `route:X:import-end`). `PerfPanel.tsx` mounts in dev-only (gated on `_llmDebugLogActive` or `?perfDebug=1`); measurements dumped to `window.opencoo_perf` debug array for Lighthouse/web-vitals collection.
- **C7** — Cross-route visual-consistency snapshot test. Vitest + jsdom renders every route (MSW-mocked admin-API), asserts: exactly one `<h1>` per route, `<Display>` lands in exactly 3 places, no inline `color: #...` literals (W11's audit fence + C4's `<font-family>` lint hand-off), sidebar renders 9 tab labels in both locales. Fails CI on drift.

### Phase 5 — Closeout (1 PR, serial last)

- **WZN** — `CHANGES-v0.1.md` wave-16 closeout (Added / Deferred / Risk-residual mirroring wave-15's PR-W12); `IMPLEMENTATION-PLAN.md` §1.1 status snapshot flip + new §1.2.26 wave row; `design_system/README.md` documents `<Display>` as the only Instrument Serif call site + the `help.<term>` i18n namespace; ships under `0.1.0-a.14.<final>`. Includes the iconography-escalation note (no fourth glyph promoted; `?` character stays as the Tooltip trigger).

---

## Cross-cutting design decisions

**Native `<dialog>` over ARIA-modal divs.** A1's foundation choice. Browser support floor (Chrome 37+, Firefox 98+, Safari 15.4+) is cleared by current build target. Free focus-trap, free Esc, free top-layer `inert`, free `:modal` CSS hook. Backdrop-click-close preserved via target-equality check. The single Firefox quirk (no font inheritance on `<dialog>`) solved with explicit `font-family: inherit` rule. Library alternatives (focus-trap-react, Radix Dialog, @reach/dialog) rejected per the wave-12 "no `*-react` UI shims" rule.

**No animation loop besides heartbeat-pulse.** B1's skeleton has zero shimmer; depth via border + paper-2. C5's hover transitions are one-shot ease-out. B5's saving-cue is a one-shot 600ms fade. B7's toast mount/dismiss is one-shot. C6's density toggle is instant (CSS attribute swap, no transition). The design-system "exactly one loop" rule is preserved.

**Optimistic UI does not weaken audit-write-before-mutate.** The server's audit-write-before-UPDATE invariant lives at every state-changing admin route. B5's client-side optimism only shifts render timing — on failure the local state rolls back and no audit row exists. The blacklist (sovereignty-token flows, credential rotation, `memory_clear`, deletes) preserves the round-trip where the round-trip is the UX (the diff-preview-confirm IS the prompt-override flow).

**Locale persistence is two-tier.** localStorage is the SoT during a session; DB column `users.locale_preference` is the SoT at login. Cross-machine: if an operator changes locale on machine A and logs into machine B, machine B reads the DB value at login then writes localStorage. If they change on machine A while still logged into B, B keeps its localStorage value until next login — locale is a per-device chrome preference more than a per-account one (mirrors IDE themes). New additive migration 0015 ships the column; the C2 route handler PATCHes it.

**`Instrument Serif` only via `<Display>`.** C4's component is the only legal call site. An ESLint rule fails any other inline reference. Three strategic placements ship together (Reports lede, Prompts empty-state, Domains summary); a `<Display level={1}>` path stays for a future docs site but the UI lints level=1 inside the management console.

**`?` over fourth glyph for tooltip trigger.** C1's affordance is a `<button>` with a mono `?` character at micro size. The glyph trio (RingWithDot/FilledDisc/OpenArc) is reserved for product-concept iconography; UI affordances use type. If operator research finds `?` reads as low-affordance, we file an `info-dot` composition (open arc + small filled disc, stacked) as a post-wave-16 candidate.

**Polish translation: LLM-first, native-speaker follow-up.** C3 ships a complete LLM (Claude) Polish pass + plural forms + `tools/i18n-check.ts` CI fence. A native-Polish-speaker review lands as a separate post-wave-16 fix-up PR; the wave-16 gate does NOT block on it (per user direction). This trades v0.1 imperfection for ship velocity.

**Wave-end gate runs against the partner deployment.** Same pattern as wave-15. Full screen-reader walk, axe-core CI green, contrast sweep green, perceived-perf measurements collected, locale parity confirmed.

---

## Verification (wave-end gate against `0.1.0-a.14.<final>`)

**Per-PR gates** (every PR before merge):
- `pnpm lint && pnpm typecheck && pnpm test` green at root.
- `pnpm test --filter @opencoo/ui -- accessibility` green (new contrast + axe-core unit tests).
- THREAT-MODEL §5 PR checklist run.
- GitHub Copilot inline triage cleared.
- New tests pin new behaviour (TDD per `CONVENTIONS.md` §3).

**Wave-end gate**:

1. **axe-core CI job** green against the built bundle, all routes × all modals × `en` + `pl`. Zero `serious` or `critical`.
2. **Contrast sweep** green; no `colors_and_type.css` pair below threshold in either density mode.
3. **Manual NVDA + VoiceOver walk** against the partner deployment (the A7 checklist in `IMPLEMENTATION-PLAN.md`). Operator completes every step keyboard-only.
4. **Reduced-motion** — flip OS-level `prefers-reduced-motion: reduce`; verify heartbeat-pulse stops (or steps to one-shot); B5 saving-cue + C5 hover + B7 toast all clamp to ≤80ms.
5. **Perceived perf** — Lighthouse run vs pre-wave: target FCP +30%, LCP +20%, CLS → ~0. B8's `window.opencoo_perf` confirms route-warm-cache "click-to-data" drops from blank+layout-shift to skeleton+stable.
6. **Onboarding fresh-deploy walk** — `docker compose down -v && up`; PAT-login lands on the four-step wizard; walk to first heartbeat without leaving the chrome.
7. **Optimistic-rollback** — force-fail a `name` PATCH with a synthetic 422; verify rollback + toast + chip restoration.
8. **Locale parity** — switch to `pl`, repeat manual SR walk + onboarding wizard + every modal. Every announcement in Polish.
9. **Cross-route snapshot** (C7) green: exactly 1 `<h1>` per route, exactly 3 `<Display>` placements, no inline color literals.
10. **THREAT-MODEL §5 maintainer walk** against closing commit. No new state-changing routes (except C2's locale PATCH which is admin-team gated with audit verb `user.set_locale_preference`); no operator-freeform text in live regions; no `dangerouslySetInnerHTML` introduced.
11. **Regression** — re-run the wave-15 partner-Chrome QA from `phase-a-15-management-ui-completeness.md`. Every wave-15 behaviour still works.

---

## Out of scope (explicit, defer)

- **Native-Polish-speaker review of C3's translation** — scheduled as a separate fix-up PR after wave-16 ships; not a gate.
- **Mobile / narrow-viewport** — opencoo is a desktop operator console. Narrow-viewport graceful degradation is v0.2.
- **Full WCAG 2.2 AAA** — floor here is AA (4.5:1 contrast, 24px target sizes optional). AAA goals revisited in v0.2.
- **Dark mode (`prefers-color-scheme: dark`)** — the design system is paper-on-ink by deliberate choice. A dark variant requires a second contrast sweep + accent recalibration; v0.2.
- **Self-voicing / TTS** — out of product scope.
- **Real-browser pixel-diff visual regression** — C7's snapshot test is structural (jsdom). A Playwright + visual-regression suite is an order of magnitude more expensive to maintain; deferred to v0.2 unless C7 misses real drifts.
- **Per-screen density-toggle override** — single global density only. Per-screen density violates the "one spacing scale" rule.
- **Fourth glyph promotion** — no new glyph in wave-16. `?` character for tooltip; `info-dot` composition deferred to operator-research signal.
- **Cleanup pipeline reading `sources_bindings.retention_days_override`** — wave-15 W5 deferred this; remains an operational follow-up outside wave-16's UX scope.
- **Per-row Retry buttons on the wave-14 W4 intake panel** — operational follow-up outside wave-16's scope.
- **Asana channel-config `assignee_gid` UI** — operational follow-up.

---

## Reuse — call these, do not reinvent

- `packages/ui/src/components/Modal.tsx:154-245` — shared modal shell. A1 upgrades it in place; every existing consumer inherits.
- `packages/ui/src/components/Field.tsx:43-166` — controlled/uncontrolled discriminated union. A3 extends with two `id` outputs (helper + error chain); B4 adds `validationStatus` prop. Modes survive.
- `packages/ui/src/components/TextField.tsx`, `TextArea.tsx` — wave-15 W9 primitives; inherit A3 transparently.
- `packages/ui/src/components/PatEntryModal.tsx:129-226` — A1 collapses onto the shared shell; visual styling vars stay.
- `packages/ui/src/components/Chrome.tsx:52-127, 135-165` — A2 adds landmark semantics + `<h2>` sidebar groups + active `aria-current="page"`; C2 adds the locale switcher to TopBar; C6 adds the density toggle.
- `packages/ui/src/styles/app.css:49-55` — `focus-visible` rule already correct; A6 adds skip-link sibling rule.
- `packages/ui/src/styles/colors_and_type.css` — CSS vars canonical; A6 contrast sweep parses this file directly; C4 references existing `t-display`/`t-lede` classes (lines 99-106, 158-166); C5 references `--ease-transform`/`--ease-write` (lines 78-82); C6 density variant scopes spacing vars (lines 52-60); no new keyframes.
- `packages/ui/src/components/Card.tsx:15-66` — B1 skeleton primitives compose on this; C5 adds opt-in `clickable` prop; same border + paper-2 recipe.
- `packages/ui/src/components/Btn.tsx:15-36` — variant token map covers every CTA; C5 adds explicit `:hover` per variant; B7 toast actions use this.
- `packages/ui/src/routes/Reports.tsx:505-631` — `HeartbeatDiagnosticsPanel` is B3's template; extract `EmptyStatePanel` from it.
- `packages/ui/src/components/SchedulerEditor.tsx:31` — `cron-parser` import; B4's cron validator reuses this exact dep + pattern. Existing "Next 5 fires" preview formatter reusable as helper.
- `packages/ui/src/components/NoticeRow.tsx` — kept for terminal errors inside the new diagnostic panels.
- `packages/ui/src/lib/api.ts` — `fetchAdmin`, `fetchOptsFor`, `ApiAuthError`, `ApiValidationError`, `ApiTransientError`. B5's optimistic hook wraps `fetchAdmin`; rollback branches on error class.
- `packages/ui/src/lib/safe-error.ts` — `safeErrorMessage` for B7 toast detail bodies (never echo raw server errors).
- `packages/ui/src/components/Glyph.tsx` — `GlyphOpenArc`/`GlyphFilledDisc`/`GlyphRingWithDot`. C1 does NOT add a fourth.
- `packages/ui/src/components/Badge.tsx` — wave-15 primitive; B6 wizard step status pills.
- `packages/ui/src/components/NewDomainModal.tsx:106` — `slugifyDisplayName` for B6's step-1 default; already exported.
- `packages/ui/src/components/CommandPalette.tsx` — wave-15 W10. A5 layers combobox + listbox semantics; matcher + result sources stay.
- `packages/ui/src/components/AgentInstancePromptsSection.tsx`, `SourceBindingDetail.tsx` — A5 audits expandable-row chevrons (`<button>` + `aria-expanded`/`aria-controls`).
- `packages/ui/src/lib/i18n.ts:14-46` — C2 wires `i18n.changeLanguage()` through existing detector; C3 adds plural forms.
- `packages/ui/src/locales/en.json:63, 102, 583, 840` — `help.*` namespace partially populated; C1 expands, C3 translates.
- `packages/ui/src/routes/Cost.tsx:127-147` — `formatUsd` + `intlLocale`; C3 lifts to `lib/intl-format.ts`, doesn't re-implement.
- `packages/shared/src/db/schema/users.ts` — C2 adds `locale_preference` column via additive migration 0015 (Drizzle ALTER); mirrors the W3 PATCH pattern from `domains.ts:85-91`.
- `packages/engine-self-operating/src/admin-api/audit-log.ts` — C2 adds `user.set_locale_preference` audit verb. Metadata: `{user_id, new_locale, caller_username}`.
- `docs/plan-appendix/phase-a-15-management-ui-completeness.md` — wave-doc style template; appendix-16 doc matches the prose density + section structure.

---

## Critical files to be modified

- `packages/ui/src/components/Modal.tsx` (A1)
- `packages/ui/src/components/PatEntryModal.tsx` (A1)
- `packages/ui/src/components/Field.tsx` (A3)
- `packages/ui/src/components/TextField.tsx`, `TextArea.tsx` (A3, inherit)
- `packages/ui/src/components/Chrome.tsx` (A2, A5, C2, C6)
- `packages/ui/src/App.tsx` (A2 main landmark + A6 skip-link + A4 toast region + B2 lazy routes + B8 perf instrumentation)
- `packages/ui/src/routes/{Activity,Audit,Cost,Reports,Review}.tsx` (A2 h1 addition)
- `packages/ui/src/components/Skeleton.tsx` (NEW — B1)
- `packages/ui/src/components/EmptyStatePanel.tsx` (NEW — B3, extracted from Reports W8 panel)
- `packages/ui/src/components/Toast.tsx` (NEW — B7)
- `packages/ui/src/components/Tooltip.tsx` (NEW — C1)
- `packages/ui/src/components/Display.tsx` (NEW — C4)
- `packages/ui/src/components/OnboardingWizard.tsx` (NEW — B6)
- `packages/ui/src/components/PerfPanel.tsx` (NEW — B8, dev-only)
- `packages/ui/src/hooks/useLiveValidation.ts` (NEW — B4)
- `packages/ui/src/hooks/useOptimisticPatch.ts` (NEW — B5)
- `packages/ui/src/hooks/useDensity.ts` (NEW — C6)
- `packages/ui/src/lib/announce.ts` (NEW — A4 `pushAnnouncement`)
- `packages/ui/src/lib/intl-format.ts` (NEW — C3, lifted from Cost.tsx)
- `packages/ui/src/lib/i18n.ts` (C2, C3)
- `packages/ui/src/lib/perf-marks.ts` (NEW — B8)
- `packages/ui/src/locales/en.json`, `pl.json` (A2 h1 keys + B3 empty-state copy + B4 validation chips + B6 wizard copy + B7 toast strings + C1 help.* + C2 locale labels + C3 full PL pass + C6 density labels)
- `packages/ui/src/components/CommandPalette.tsx` (A5 combobox semantics + C6 density-aware row height)
- `packages/ui/src/components/AgentInstancePromptsSection.tsx`, `SourceBindingDetail.tsx` (A5 chevron audit)
- `packages/ui/src/components/{NewDomainModal,NewSourceBindingModal,NewAgentInstanceModal}.tsx` (B4 validation chips)
- `packages/ui/src/components/{AgentInstanceDetail,OutputChannelDetail,DomainDetail}.tsx` (B5 optimistic wiring)
- `packages/ui/src/routes/Reports.tsx`, `Prompts.tsx`, `Domains.tsx` (C4 Display placements)
- `packages/ui/src/styles/colors_and_type.css` (C6 density-scoped vars + A6 skip-link rule + C5 reduced-motion media query)
- `packages/ui/eslint.local.js` (NEW — C4 ESLint rule for Instrument Serif scope)
- `packages/ui/vite.config.ts` (B2 dynamic-import boundary)
- `packages/ui/tests/accessibility/contrast.test.ts` (NEW — A6)
- `packages/ui/tests/visual-consistency.test.tsx` (NEW — C7)
- `packages/ui/tests/ui/bundle-size.test.ts` (NEW — B2)
- `tools/i18n-check.ts` (NEW — C3 PL-completeness fence)
- `packages/shared/src/db/schema/users.ts` (C2 `locale_preference` column)
- `packages/shared/drizzle/0015_users_locale_preference.sql` (NEW migration)
- `packages/engine-self-operating/src/admin-api/routes/users.ts` (NEW — C2 `PATCH /api/admin/users/me/locale`)
- `packages/engine-self-operating/src/admin-api/audit-log.ts` (C2 audit verb `user.set_locale_preference`)
- `IMPLEMENTATION-PLAN.md` §1.1 snapshot + new §1.2.26 wave row (WZN)
- `CHANGES-v0.1.md` wave-16 closeout section (WZN)
- `design_system/README.md` `<Display>` + `help.*` documentation (WZN)
- `docs/plan-appendix/phase-a-16-impeccable-ux.md` (NEW — WZ0 ports this plan)

---

## Verification of end-to-end testing

After wave-16 closes, walk the partner deployment through these scenarios — each one corresponds to a wave-end-gate criterion above:

```
1. Open the partner deployment in Chrome with NVDA running (or Safari with VoiceOver).
   Hear "opencoo, heading level 1" on the login surface. Type a bad PAT;
   hear the inline alert announce. Type a good PAT; hear the toast region announce success.

2. Tab through the sidebar. Hear "Operate, heading level 2"; arrow-down to Agents;
   Enter. Land on Agents; hear "Main, Agents, heading level 1". Tab to Cmd-K;
   open palette; hear "Search command palette, combobox"; type "wiki-exec";
   arrow-down; hear next option; Enter; land on DomainDetail.

3. Edit a non-destructive field (rename "morning" → "weekday-morning"):
   the new name appears immediately; the saving-cue dot fades in; PATCH confirms;
   dot disappears; toast region announces "Agent instance renamed to weekday-morning".

4. Force a 422 on the same PATCH (synthetic — change to an over-long name):
   new name appears; dot fades in then turns red; rollback restores;
   alert-red toast surfaces "Name must be ≤100 chars" with details-expand.

5. Toggle TopBar locale to Polski; hear "Language changed to Polski";
   every visible string renders in Polish. Walk the same path through Prompts:
   open editor; preview diff; sovereignty-token countdown announces in Polish.

6. Reload with an empty deploy (`docker compose down -v && up`); land on
   Domains; the onboarding wizard renders inline as the empty-state body;
   walk steps 1-4; the W8 precondition chain inside step 4 confirms heartbeat.

7. Toggle density to compact; verify row padding tightens; Cmd-K palette
   row height adapts; contrast sweep still green (re-run A6 manually).

8. Run Lighthouse against any route: FCP < (pre-wave baseline × 0.7);
   CLS ~0; entry chunk < 200 KB (B2 fence).

9. Trigger `prefers-reduced-motion: reduce` at the OS level: heartbeat-pulse
   on operate glyph stops; B5 saving-cue clamps to ≤80ms; B7 toast mount
   clamps; C5 hover transitions clamp.

10. Walk the wave-15 verification (per `phase-a-15-management-ui-completeness.md` §Verification)
    end-to-end. Every wave-15 behaviour still works.
```

If any step fails, the wave does not ship until fixed.

---

*Derived from the wave-15 closeout (`docs/plan-appendix/phase-a-15-management-ui-completeness.md`), `architecture.md` §3.5 admin trust class, `THREAT-MODEL.md` §3.13 admin authz + §5 PR checklist, `design_system/README.md` accent budgets + hard nos + Instrument Serif scoping, three Plan-agent designs synthesized after a Chrome-driven QA pass against the partner deployment. When this plan drifts, update it in the same PR as the code change.*

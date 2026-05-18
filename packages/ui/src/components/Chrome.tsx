/**
 * Sidebar + TopBar — IA polish for PR-W10 (phase-a appendix
 * #15 wave-15); semantic-landmark refinement for PR-A2 (wave-16);
 * roving-tabindex keyboard navigation for PR-A5 (wave-16).
 *
 * Wave-16 PR-A2 changes (does not alter visual chrome):
 *   - TopBar root becomes `<header role="banner">`.
 *   - Sidebar `<nav>` carries `aria-label={t("nav.primary")}`.
 *   - Sidebar group labels become `<h2>` (same micro-label visual
 *     recipe) so the sidebar contributes a real document outline.
 *   - The active tab button carries `aria-current="page"`.
 *
 * Wave-16 PR-A5 — W3C APG menubar pattern, vertical adaptation:
 *   - Exactly one nav button is in the Tab sequence at a time:
 *     the active tab gets `tabindex="0"`; every other entry gets
 *     `tabindex="-1"`. Focus moves within the sidebar via arrow
 *     keys, not the Tab key.
 *   - Up/Down move focus WITHIN the current group; the group
 *     boundary is hard (no wrap into the next group). Left/Right
 *     move focus BETWEEN groups (to the FIRST entry of the
 *     previous/next group), without wrapping past either end.
 *     Home/End jump to the global first/last entry.
 *   - aria-current="page" stays on the *active* tab regardless of
 *     where roving focus has landed — focus is independent of
 *     selection. setTab is still the dispatcher (Enter/Space
 *     route through the native button onClick chain).
 *
 * The corresponding `<main aria-labelledby="opencoo-page-h1">`
 * lives in App.tsx; routes own the `<h1 id="opencoo-page-h1">`
 * the landmark name resolves against (one h1 per route).
 *
 * The sidebar groups tabs into four named clusters so the
 * flat 11-tab list reads as a coherent product chrome:
 *   - Operate     — daily-task primacy (Agents · Outputs · Activity)
 *   - Knowledge   — what the wiki is made of (Domains · Sources · Prompts)
 *   - Governance  — review + policy + spend (Review · LlmPolicy · Cost · Audit)
 *   - Diagnostics — observability (Reports)
 *
 * The TopBar replaces the bare uppercase tab title with a
 * `<group> / <tab> [ / <row-name> ]` breadcrumb. The third
 * segment is optional — pages with no drill-down render the
 * two-segment form. The `crumb` prop carries the lifted
 * row-name from the active route; it's prop-drilled rather
 * than threaded through a context because exactly one consumer
 * needs it (TopBar) and the value is a single string.
 *
 * The visual grouping changes only the sidebar layout — the
 * existing `tab` enum + `setTab` plumbing in App.tsx stays
 * unchanged. Cmd-K palette navigation also goes through
 * `setTab`, so the route table in App.tsx remains the single
 * source of truth for tab keys.
 *
 * Design-system invariants honored:
 *   - mono-uppercase micro-label per group (Geist micro-label
 *     pattern, sized 10px tracking 0.08em — same recipe as the
 *     existing footer in `app.version · app.tagline`)
 *   - no color literals — only design-system CSS vars
 *   - no second motion loop (group labels are static; only the
 *     heartbeat pulse is animated, owned by the operate glyph)
 *   - no emoji / no marketing voice / no pills / no gradients
 */
import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useDensity, type Density } from "../hooks/useDensity.js";
import type { SupportedLocale } from "../lib/i18n.js";
import type { Tab } from "../types.js";

import { Btn } from "./Btn.js";
import { LocaleSwitcher } from "./LocaleSwitcher.js";

interface SidebarProps {
  readonly tab: Tab;
  readonly setTab: (t: Tab) => void;
  /** PR-B2 (wave-16) — fire the matching lazy `import()` to
   *  warm the chunk before the click lands. Bound to both
   *  `onMouseEnter` and `onFocus` so mouse + keyboard
   *  navigation get the same perceived-latency boost. Optional
   *  so callers that don't ship route splitting (tests, design-
   *  system previews) can omit the prop. */
  readonly prefetch?: (t: Tab) => void;
}

/** Group order is fixed: Operate first carries daily-task primacy. */
type GroupKey = "operate" | "knowledge" | "governance" | "diagnostics";

interface GroupSpec {
  readonly key: GroupKey;
  readonly labelKey: string;
  readonly tabs: ReadonlyArray<{ key: Tab; labelKey: string }>;
}

export const GROUPS: ReadonlyArray<GroupSpec> = [
  {
    key: "operate",
    labelKey: "nav.groups.operate",
    tabs: [
      { key: "agents", labelKey: "nav.agents" },
      { key: "outputs", labelKey: "nav.outputs" },
      { key: "activity", labelKey: "nav.activity" },
    ],
  },
  {
    key: "knowledge",
    labelKey: "nav.groups.knowledge",
    tabs: [
      { key: "domains", labelKey: "nav.domains" },
      { key: "sources", labelKey: "nav.sources" },
      { key: "prompts", labelKey: "nav.prompts" },
    ],
  },
  {
    key: "governance",
    labelKey: "nav.groups.governance",
    tabs: [
      { key: "review", labelKey: "nav.review" },
      { key: "llmPolicy", labelKey: "nav.llmPolicy" },
      { key: "cost", labelKey: "nav.cost" },
      { key: "audit", labelKey: "nav.audit" },
    ],
  },
  {
    key: "diagnostics",
    labelKey: "nav.groups.diagnostics",
    tabs: [{ key: "reports", labelKey: "nav.reports" }],
  },
];

/** Reverse lookup — given a tab, what group does it belong to?
 *
 *  `Tab` is a closed union, so in steady-state every value is
 *  covered above. The throw path catches the *future* case where
 *  a new tab is added to `types.ts` without being assigned to a
 *  group — a silent fallback would render an incorrect breadcrumb
 *  / sidebar mapping with no signal (Copilot triage on PR-W10).
 *  Throwing fails the next mount in dev/test so the omission is
 *  caught immediately. */
export function groupForTab(tab: Tab): GroupSpec {
  for (const g of GROUPS) {
    if (g.tabs.some((t) => t.key === tab)) return g;
  }
  // Exhaustiveness assertion — if a new Tab value is added without
  // being assigned to GROUPS, this throw fires. The `never` cast
  // makes the omission a TS error at compile time when paired with
  // a `switch (tab) { … default: const _ : never = tab }` style
  // check, which isn't applicable here (we iterate GROUPS, not
  // tabs). Runtime throw is the fallback.
  throw new Error(`Chrome.tsx: no group assignment for tab="${tab as never}"`);
}

const MICRO_LABEL_STYLE = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--ink-3)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
} as const;

/** PR-A2 — visually-hidden recipe shared by sub-tab routes that
 *  carry a hidden `<h1 id="opencoo-page-h1">` so the
 *  `<main aria-labelledby="opencoo-page-h1">` landmark name
 *  resolves without duplicating the W10-breadcrumb page identifier
 *  visually. Routes import { SR_ONLY_STYLE } from "./Chrome.js"
 *  rather than re-declaring the same `.sr-only` block in three
 *  places (Copilot triage on PR-A2). */
export const SR_ONLY_STYLE = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  borderWidth: 0,
} as const;

export function Sidebar(props: SidebarProps): JSX.Element {
  const { t } = useTranslation();

  // PR-A5 — keyboard-navigation infrastructure.
  //
  // `flat` is the global document-order list of (groupIdx, tabIdx,
  // Tab key) triples — the same canonical Operate · Knowledge ·
  // Governance · Diagnostics order the sidebar paints. Computed
  // each render rather than memoized: GROUPS is a module constant
  // so the cost is bounded + the dependency-array bookkeeping would
  // be more complex than the recomputation.
  const flat: ReadonlyArray<{
    readonly groupIdx: number;
    readonly tabIdx: number;
    readonly tab: Tab;
  }> = GROUPS.flatMap((group, groupIdx) =>
    group.tabs.map((entry, tabIdx) => ({
      groupIdx,
      tabIdx,
      tab: entry.key,
    })),
  );

  // Button refs keyed by Tab so the keydown handler can call
  // .focus() on the target. A Map (not an object) — Tab is a union
  // of strings so either works, but a Map keeps the type narrowing
  // exact without a Record<Tab, …> shape that requires every key.
  const buttonRefs = useRef<Map<Tab, HTMLButtonElement | null>>(new Map());

  const focusTab = (tab: Tab): void => {
    const el = buttonRefs.current.get(tab);
    if (el !== null && el !== undefined) el.focus();
  };

  const onKeyDownForTab = useCallback(
    (tab: Tab) =>
      (e: React.KeyboardEvent<HTMLButtonElement>): void => {
        // Find the position of this tab in the canonical flat list.
        const here = flat.findIndex((f) => f.tab === tab);
        if (here < 0) return;
        const { groupIdx, tabIdx } = flat[here]!;
        const group = GROUPS[groupIdx]!;
        switch (e.key) {
          case "ArrowDown": {
            // Within-group move; don't wrap into next group.
            if (tabIdx < group.tabs.length - 1) {
              e.preventDefault();
              focusTab(group.tabs[tabIdx + 1]!.key);
            } else {
              // At end of group — pin so the browser doesn't scroll.
              e.preventDefault();
            }
            return;
          }
          case "ArrowUp": {
            if (tabIdx > 0) {
              e.preventDefault();
              focusTab(group.tabs[tabIdx - 1]!.key);
            } else {
              e.preventDefault();
            }
            return;
          }
          case "ArrowRight": {
            // Inter-group move to FIRST entry of next group.
            if (groupIdx < GROUPS.length - 1) {
              e.preventDefault();
              focusTab(GROUPS[groupIdx + 1]!.tabs[0]!.key);
            } else {
              e.preventDefault();
            }
            return;
          }
          case "ArrowLeft": {
            if (groupIdx > 0) {
              e.preventDefault();
              focusTab(GROUPS[groupIdx - 1]!.tabs[0]!.key);
            } else {
              e.preventDefault();
            }
            return;
          }
          case "Home": {
            e.preventDefault();
            focusTab(flat[0]!.tab);
            return;
          }
          case "End": {
            e.preventDefault();
            focusTab(flat[flat.length - 1]!.tab);
            return;
          }
          // Enter + Space fall through to the native button onClick
          // chain — no preventDefault, no synthesized setTab here.
          // That preserves the W10 dispatch contract and survives
          // future click-handler refactors automatically.
          default:
            return;
        }
      },
    [flat],
  );

  return (
    // PR-A2 — aria-label scopes the <nav> to "primary navigation"
    // for assistive tech. The label key (nav.primary) gets a
    // default English string + a mirrored PL placeholder.
    <nav
      aria-label={t("nav.primary")}
      style={{
        width: 240,
        background: "var(--paper-2)",
        borderRight: "1px solid var(--rule)",
        padding: "22px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        fontFamily: "var(--font-sans)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 8px 18px",
          borderBottom: "1px solid var(--rule)",
          marginBottom: 10,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            letterSpacing: "-0.005em",
            color: "var(--ink)",
          }}
        >
          {t("app.title")}
        </span>
      </div>
      {GROUPS.map((group, idx) => (
        <div
          key={group.key}
          data-group={group.key}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            // First group sits flush against the title row; later
            // groups get a top gap so the section breaks read as
            // breathing room, not a rule.
            marginTop: idx === 0 ? 0 : 12,
          }}
        >
          {/* PR-A2 — group header is an <h2>, not a <div>, so the
              sidebar has a real document outline (banner / main /
              nav and four h2 group headings). Visual recipe is
              unchanged: same mono-uppercase micro-label, same
              padding. `margin: 0` strips the default <h2> chrome
              that would otherwise add browser leading; `fontWeight:
              400` keeps the micro-label flat, matching the prior
              <div>'s computed weight. */}
          <h2
            style={{
              ...MICRO_LABEL_STYLE,
              fontWeight: 400,
              margin: 0,
              padding: "4px 10px 6px",
            }}
          >
            {t(group.labelKey)}
          </h2>
          {group.tabs.map((item) => {
            const active = props.tab === item.key;
            // PR-A2 — aria-current="page" on the active tab; the
            // attribute is omitted (not literally set to "false")
            // for inactive entries so assistive tech sees a single
            // canonical current-page marker.
            const ariaCurrent = active
              ? ({ "aria-current": "page" } as const)
              : {};
            // PR-B2 — prefetch on hover + focus warms the lazy
            // route chunk before the click lands. The same
            // dynamic `import()` Vite already split is re-called
            // here so the browser's module-record cache dedupes
            // and the post-click resolution is synchronous.
            const onPrefetch = (): void => {
              props.prefetch?.(item.key);
            };
            return (
              <button
                key={item.key}
                ref={(el): void => {
                  // PR-A5 — register/unregister the button ref so
                  // arrow-key handlers can .focus() peers without
                  // a DOM query. Clear on unmount to avoid a stale
                  // reference if the sidebar re-mounts.
                  if (el === null) buttonRefs.current.delete(item.key);
                  else buttonRefs.current.set(item.key, el);
                }}
                onClick={(): void => props.setTab(item.key)}
                onKeyDown={onKeyDownForTab(item.key)}
                {...ariaCurrent}
                // PR-A5 — roving tabindex. Only the active tab is
                // in the Tab sequence; everything else is reachable
                // only via the arrow keys (the W3C APG menubar
                // contract). aria-current="page" is independent —
                // it tracks the active tab, not the focused tab.
                tabIndex={active ? 0 : -1}
                onMouseEnter={onPrefetch}
                onFocus={onPrefetch}
                // PR-C5: hover affordance via shared class. The
                // active row already carries paper / rule, so the
                // hover-class lifts only inactive entries to paper.
                // Composed with PR-A2's aria-current="page" — both
                // attach to the same <button>, neither overrides
                // the other.
                className="opencoo-hover-sidebar"
                style={{
                  textAlign: "left",
                  font: "inherit",
                  fontSize: 13,
                  padding: "8px 10px",
                  background: active ? "var(--paper)" : "transparent",
                  border: "1px solid",
                  borderColor: active ? "var(--rule)" : "transparent",
                  borderRadius: 4,
                  color: active ? "var(--ink)" : "var(--ink-2)",
                  cursor: "pointer",
                }}
              >
                {t(item.labelKey)}
              </button>
            );
          })}
        </div>
      ))}
      <div
        style={{
          marginTop: "auto",
          paddingTop: 12,
          borderTop: "1px solid var(--rule)",
          ...MICRO_LABEL_STYLE,
        }}
      >
        {t("app.version")} · {t("app.tagline")}
      </div>
    </nav>
  );
}

interface TopBarProps {
  /** Active tab — drives the breadcrumb's middle segment + the
   *  group-name segment via `groupForTab(tab)`. */
  readonly tab: Tab;
  /** Optional row-name shown as the third breadcrumb segment.
   *  Pages with a drill-down lift the selected row's name into
   *  this prop; pages without a drill-down (or with no row
   *  open) pass `undefined` and the bar renders the two-segment
   *  form. */
  readonly crumb?: string;
  readonly username: string | null;
  readonly onLogout: () => void;
  /** Optional locale-PATCH callable for the TopBar's
   *  LocaleSwitcher (PR-C2 wave-16). When provided, the switcher
   *  flips i18n + localStorage immediately and PATCHes the DB in
   *  the background; failures don't regress local state. Omit
   *  (test usage) to suppress the switcher entirely. */
  readonly onChangeLocale?: (locale: SupportedLocale) => Promise<void>;
}

const CRUMB_SEP_STYLE = {
  fontFamily: "var(--font-mono)",
  color: "var(--ink-3)",
  margin: "0 8px",
  // No animation, no color shift — the separator is a static
  // divider, not a motion cue.
} as const;

/** Density toggle (PR-C6, wave-16) — sits next to the locale
 *  switcher in the TopBar. Two discrete buttons (comfortable /
 *  compact) so the active state is a true visual press, not a
 *  hidden dropdown the operator has to open to see which mode
 *  they're in. `aria-pressed` carries the toggle semantics to
 *  assistive tech without needing a separate role + state pattern.
 *
 *  Instant attribute swap on click — no CSS transition (the
 *  design-system "exactly one motion loop" rule lets only the
 *  heartbeat-pulse animate; everything else is either one-shot or
 *  immediate, and density is the latter). */
const DENSITY_OPTIONS: ReadonlyArray<Density> = ["comfortable", "compact"];

function DensityToggle(): JSX.Element {
  const { t } = useTranslation();
  const { density, setDensity } = useDensity();
  return (
    <div
      data-component="density-toggle"
      role="group"
      aria-label={t("density.ariaLabel")}
      style={{
        display: "inline-flex",
        // 1px-thick "segmented control" — a single border around the
        // pair, inner separator is the border between buttons.
        border: "1px solid var(--rule)",
        borderRadius: 3,
        overflow: "hidden",
        // Mono chrome to fit the TopBar's existing typography.
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        letterSpacing: "0.04em",
        background: "var(--paper)",
      }}
    >
      {DENSITY_OPTIONS.map((opt, idx) => {
        const active = density === opt;
        return (
          <button
            key={opt}
            type="button"
            aria-pressed={active}
            data-density-option={opt}
            onClick={(): void => {
              setDensity(opt);
            }}
            style={{
              font: "inherit",
              padding: "3px 8px",
              border: "none",
              // Inner divider between the two buttons — mirrors the
              // segmented-control idiom without introducing a new
              // ruler color.
              borderLeft: idx === 0 ? "none" : "1px solid var(--rule)",
              background: active ? "var(--paper-2)" : "transparent",
              color: active ? "var(--ink)" : "var(--ink-3)",
              cursor: "pointer",
              // Buttons read lowercase — the TopBar root carries
              // `textTransform: uppercase`, so the button override
              // restores the readable lowercase form for the toggle.
              textTransform: "lowercase",
            }}
          >
            {t(`density.${opt}`)}
          </button>
        );
      })}
    </div>
  );
}

export function TopBar(props: TopBarProps): JSX.Element {
  const { t } = useTranslation();
  const group = groupForTab(props.tab);
  const groupLabel = t(group.labelKey);
  const tabSpec = group.tabs.find((tt) => tt.key === props.tab);
  // tabSpec is guaranteed by groupForTab — fall through is
  // defensive only.
  const tabLabel = tabSpec ? t(tabSpec.labelKey) : props.tab;
  return (
    // PR-A2 — TopBar is the page banner. <header role="banner">
    // exposes it as a landmark for assistive tech / "skip to
    // main" keyboard nav. Explicit role survives nesting inside
    // future flex containers (where an implicit role can vanish).
    <header
      role="banner"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "14px 24px",
        borderBottom: "1px solid var(--rule)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--ink-3)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
      }}
    >
      <span data-crumb="root">
        <span data-crumb="group">{groupLabel}</span>
        <span style={CRUMB_SEP_STYLE} aria-hidden="true">
          /
        </span>
        <span
          data-crumb="tab"
          style={{ color: "var(--ink)", fontWeight: 500 }}
        >
          {tabLabel}
        </span>
        {props.crumb !== undefined && props.crumb !== "" ? (
          <>
            <span style={CRUMB_SEP_STYLE} aria-hidden="true">
              /
            </span>
            <span
              data-crumb="row"
              style={{
                color: "var(--ink)",
                fontWeight: 500,
                // The row-name preserves operator-chosen casing
                // (slugs, IDs, locale-suffixed names) — only the
                // group / tab segments get the uppercase chrome
                // treatment that the TopBar applies to the entire
                // bar by default.
                textTransform: "none",
                letterSpacing: 0,
                fontFamily: "var(--font-mono)",
              }}
            >
              {props.crumb}
            </span>
          </>
        ) : null}
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {props.username !== null ? (
          <span>{t("auth.loggedInAs", { username: props.username })}</span>
        ) : null}
        {/* PR-C2 wave-16: operator-controlled locale toggle.
            Omitted in test renders that don't pass onChangeLocale
            so the existing TopBar tests (PR-W10 breadcrumb pins)
            keep working without rewriting their fixtures.

            PR-C6 wave-16: density toggle inherits the same gating.
            It's a chrome-level preference; the test fixtures that
            mount TopBar without `onChangeLocale` are existence
            pins for the breadcrumb / landmark contract — adding a
            second always-on chrome control to those would force a
            sweeping fixture update for no behavioural change. */}
        {props.onChangeLocale !== undefined ? (
          <>
            <DensityToggle />
            <LocaleSwitcher onChange={props.onChangeLocale} />
          </>
        ) : null}
        <Btn variant="ghost" onClick={props.onLogout}>
          {t("nav.logout")}
        </Btn>
      </span>
    </header>
  );
}

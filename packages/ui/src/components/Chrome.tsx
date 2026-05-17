/**
 * Sidebar + TopBar — IA polish for PR-W10 (phase-a appendix
 * #15 wave-15).
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
import { useTranslation } from "react-i18next";

import type { Tab } from "../types.js";

import { Btn } from "./Btn.js";

interface SidebarProps {
  readonly tab: Tab;
  readonly setTab: (t: Tab) => void;
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

export function Sidebar(props: SidebarProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <nav
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
          <div
            style={{
              ...MICRO_LABEL_STYLE,
              padding: "4px 10px 6px",
            }}
          >
            {t(group.labelKey)}
          </div>
          {group.tabs.map((item) => {
            const active = props.tab === item.key;
            return (
              <button
                key={item.key}
                onClick={(): void => props.setTab(item.key)}
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
}

const CRUMB_SEP_STYLE = {
  fontFamily: "var(--font-mono)",
  color: "var(--ink-3)",
  margin: "0 8px",
  // No animation, no color shift — the separator is a static
  // divider, not a motion cue.
} as const;

export function TopBar(props: TopBarProps): JSX.Element {
  const { t } = useTranslation();
  const group = groupForTab(props.tab);
  const groupLabel = t(group.labelKey);
  const tabSpec = group.tabs.find((tt) => tt.key === props.tab);
  // tabSpec is guaranteed by groupForTab — fall through is
  // defensive only.
  const tabLabel = tabSpec ? t(tabSpec.labelKey) : props.tab;
  return (
    <div
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
        <Btn variant="ghost" onClick={props.onLogout}>
          {t("nav.logout")}
        </Btn>
      </span>
    </div>
  );
}

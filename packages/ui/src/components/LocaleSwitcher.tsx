/**
 * LocaleSwitcher — operator-controlled UI locale toggle (PR-C2,
 * phase-a appendix #16 wave-16).
 *
 * Two-tier persistence (see also `lib/i18n.ts:reconcileLocaleAtLogin`):
 *   - localStorage is the in-session SoT — written first so the
 *     operator's choice survives even if the DB PATCH later blips.
 *   - `users.locale_preference` is the DB SoT at login — the SPA
 *     reads it back via `/api/admin/_csrf.localePreference` and
 *     reconciles localStorage in favor of the DB on each session
 *     hydrate.
 *
 * Why a native `<select>` and not a styled menu:
 *   - Native combobox is keyboard-accessible by default (Up/Down,
 *     Enter, Esc) without re-implementing the listbox role pattern.
 *   - Mirrors the design-system "Hard nos" — no pills, no
 *     gradients; the `<select>` inherits the page's mono chrome
 *     and reads as part of the bar, not a distinct control.
 *   - Two options + low frequency of use makes the dropdown the
 *     right primitive; a button-pair would shout for attention
 *     the operator doesn't need from a chrome control.
 *
 * Error surface: a failed PATCH (422 / 5xx / network) does NOT
 * regress local state. The operator's choice is respected even
 * when the server cannot persist it; the next login will read
 * back whatever the DB last accepted. Until B7 (toast queue)
 * lands the failure surfaces via `console.warn` only — once B7
 * is wired, replace the warn with `useToast().alert(...)`.
 */
import { type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";

import i18n, {
  writeStoredLocale,
  type SupportedLocale,
} from "../lib/i18n.js";

const LOCALES: ReadonlyArray<SupportedLocale> = ["en", "pl"];

export interface LocaleSwitcherProps {
  /** Background callable that PATCHes `/api/admin/users/me/locale`.
   *  The switcher calls this AFTER flipping i18n + localStorage so
   *  the in-session UX is unblocked even if the server is slow or
   *  unreachable. Resolves on success, rejects on failure — the
   *  switcher logs (B7 toast wiring lands later) but does not
   *  regress local state.
   *
   *  Optional (PR-W18): the LocaleSwitcher is also rendered on the
   *  pre-auth PatEntryModal where there is no user row yet, so no
   *  DB PATCH should fire. Omit `onChange` on that surface — the
   *  flip still persists via localStorage, and
   *  `reconcileLocaleAtLogin` carries the choice into the
   *  authenticated session. */
  readonly onChange?: (locale: SupportedLocale) => Promise<void>;
}

export function LocaleSwitcher(props: LocaleSwitcherProps): JSX.Element {
  const { t, i18n: tInstance } = useTranslation();
  // Derive the controlled `value` directly from i18n's live
  // language. `useTranslation()` re-renders on `languageChanged`
  // so a flip from outside this component (e.g.
  // `reconcileLocaleAtLogin` at login, or another LocaleSwitcher
  // instance) keeps the select in sync without a manual
  // `useEffect` (Copilot review #166).
  const value: SupportedLocale = isSupportedLocale(tInstance.language)
    ? tInstance.language
    : "en";

  const handle = (e: ChangeEvent<HTMLSelectElement>): void => {
    const next = e.target.value;
    if (!isSupportedLocale(next)) return;
    // 1. Flip i18n synchronously so the next render reflects the
    //    new locale without waiting on storage or network. The
    //    `useTranslation()` pub/sub above re-renders this component
    //    with `value === next`.
    void i18n.changeLanguage(next);
    // 2. Write localStorage — the in-session SoT — so the next
    //    page load picks the same locale even if the DB write
    //    blips.
    writeStoredLocale(next);
    // 4. PATCH the DB in the background. Failures do NOT regress
    //    local state — the operator's choice is respected even
    //    when the server is sick. Until B7 (toast queue) is
    //    wired we log to console; the next login's `/_csrf`
    //    hydrate will surface the divergence (DB still has the
    //    prior locale) for forensic review.
    //
    //    PR-W18: `onChange` is now optional — the pre-auth
    //    PatEntryModal renders this component without it, since
    //    there is no user row yet to PATCH. In that case the local
    //    flip stands alone and reconcileLocaleAtLogin carries the
    //    choice forward.
    const onChange = props.onChange;
    if (onChange !== undefined) {
      void onChange(next).catch((err: unknown) => {
        // B7 toast wiring will replace this console.warn once the
        // queue lands; until then the failure is observable via
        // engine + browser logs only.
        console.warn(
          "LocaleSwitcher: PATCH /api/admin/users/me/locale failed; local state preserved",
          err,
        );
      });
    }
  };

  return (
    <select
      aria-label={t("locale.switcherAriaLabel")}
      value={value}
      onChange={handle}
      data-test="locale-switcher"
      style={{
        // Mono chrome to fit the TopBar's existing typography.
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        letterSpacing: "0.04em",
        color: "var(--ink)",
        background: "var(--paper)",
        // No fully-rounded pills; cap radius to match Btn (3–6px).
        border: "1px solid var(--rule)",
        borderRadius: 3,
        padding: "4px 8px",
        cursor: "pointer",
      }}
    >
      {LOCALES.map((loc) => (
        <option key={loc} value={loc}>
          {t(`locale.${loc}`)}
        </option>
      ))}
    </select>
  );
}

function isSupportedLocale(value: unknown): value is SupportedLocale {
  return value === "en" || value === "pl";
}

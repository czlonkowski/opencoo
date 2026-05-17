/**
 * i18n initialisation (PR 29 / plan #131, decision Q2).
 *
 * `react-i18next` over the static JSON resources at
 * `src/locales/`. Default to `en`; `pl` is a placeholder per
 * §17 Resolved — keys are duplicated for forward-compat so a
 * missing translation never falls back to `undefined`.
 *
 * Locale source of truth (PR-C2 two-tier persistence):
 *   - At boot: `localStorage.opencoo_locale` is the SoT.
 *     Falls back to navigator language → 'en'.
 *   - At login: the `/api/admin/_csrf` response carries
 *     `localePreference` from `users.locale_preference`.
 *     If it differs from the current localStorage value,
 *     reconcile in favor of the DB (DB is SoT at login).
 *   - During session: the LocaleSwitcher TopBar control flips
 *     i18n + localStorage immediately, then PATCHes the DB in
 *     the background. A failed PATCH does not regress local
 *     state — the operator's choice is respected even when the
 *     server is sick (B7 toast wiring will surface the gap once
 *     it lands; until then, console.warn).
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "../locales/en.json";
import pl from "../locales/pl.json";

const STORED_LOCALE_KEY = "opencoo_locale";

export type SupportedLocale = "en" | "pl";

function isSupportedLocale(value: unknown): value is SupportedLocale {
  return value === "en" || value === "pl";
}

function detectLocale(): SupportedLocale {
  if (typeof window === "undefined") return "en";
  // Some sandboxed/private contexts throw `SecurityError` on
  // localStorage access. Mirror the pat-store try/catch pattern
  // so i18n init can't crash the whole SPA when storage is
  // unavailable.
  try {
    const stored = window.localStorage?.getItem(STORED_LOCALE_KEY);
    if (isSupportedLocale(stored)) return stored;
  } catch {
    // Storage access blocked — fall through to navigator language.
  }
  const nav = window.navigator?.language ?? "en";
  return nav.toLowerCase().startsWith("pl") ? "pl" : "en";
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    pl: { translation: pl },
  },
  lng: detectLocale(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

/** Write the current operator-chosen locale to localStorage.
 *  Wrapped in try/catch because sandboxed/private contexts may
 *  throw SecurityError on storage writes (mirrors the read path
 *  in `detectLocale`). The LocaleSwitcher calls this on every
 *  flip; failures are silent — i18n still re-renders this
 *  session via `i18n.changeLanguage()`, only the cross-load
 *  persistence is degraded. */
export function writeStoredLocale(locale: SupportedLocale): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(STORED_LOCALE_KEY, locale);
  } catch {
    // Storage write blocked — operator's choice still applies
    // in-session via i18n; next load falls back to the detector.
  }
}

/** Two-tier reconciliation at login: the DB value (from
 *  `/api/admin/_csrf.localePreference`) is the SoT at login.
 *  If it differs from the in-session i18n state, update both
 *  i18n + localStorage to match. A null DB value means
 *  "no preference, fall back to the client-side default" — we
 *  leave localStorage alone in that case so the in-session SoT
 *  on this device persists. */
export function reconcileLocaleAtLogin(
  serverLocale: string | null,
): void {
  if (!isSupportedLocale(serverLocale)) return;
  if (i18n.language === serverLocale) return;
  void i18n.changeLanguage(serverLocale);
  writeStoredLocale(serverLocale);
}

export default i18n;

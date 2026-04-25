/**
 * i18n initialisation (PR 29 / plan #131, decision Q2).
 *
 * `react-i18next` over the static JSON resources at
 * `src/locales/`. Default to `en`; `pl` is a placeholder per
 * §17 Resolved — keys are duplicated for forward-compat so a
 * missing translation never falls back to `undefined`.
 *
 * Locale source of truth: `localStorage.opencoo_locale` →
 * navigator language → 'en'. Language switching happens via
 * the future Settings tab; the v0.1 UI exposes no locale
 * picker.
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "../locales/en.json";
import pl from "../locales/pl.json";

const STORED_LOCALE_KEY = "opencoo_locale";

function detectLocale(): "en" | "pl" {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage?.getItem(STORED_LOCALE_KEY);
  if (stored === "en" || stored === "pl") return stored;
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

export default i18n;

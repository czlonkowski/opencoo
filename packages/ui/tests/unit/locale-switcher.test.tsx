/**
 * Locale switcher in the TopBar (PR-C2, phase-a appendix #16
 * wave-16).
 *
 * Operator-controlled per-account locale toggle. Two-tier persistence:
 *   - localStorage is the in-session SoT (read at boot by i18n.ts).
 *   - DB column `users.locale_preference` is the SoT at login (the
 *     SPA reads it back via `/_csrf` and reconciles localStorage).
 *
 * On change the switcher:
 *   1. Calls `i18n.changeLanguage(newLocale)` so the current
 *      session re-renders immediately.
 *   2. Writes `localStorage.opencoo_locale = newLocale` so the
 *      next page load picks the same locale even if the DB write
 *      blips.
 *   3. PATCHes `/api/admin/users/me/locale` in the background. On
 *      failure (422 / 5xx / network) the local state is NOT
 *      regressed — the operator's choice is respected even when
 *      the server is sick. (B7 toast surfacing is out of scope
 *      for C2 — silent log + console.warn for the v1 ship; B7
 *      will wire it once the toast queue lands.)
 *
 * Pin matrix:
 *   1. Select renders both options (English, Polski) with the
 *      current locale pre-selected.
 *   2. Changing the select calls i18n.changeLanguage, writes
 *      localStorage, AND fires the PATCH (in that order).
 *   3. A failed PATCH (422) does NOT regress local state — both
 *      i18n.changeLanguage + localStorage stay set.
 *
 * Test seam: the switcher receives an `onChangeLocale` callable
 * (composed by Chrome.tsx in production) so we can assert on
 * the PATCH being attempted without mocking globalThis.fetch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { LocaleSwitcher } from "../../src/components/LocaleSwitcher.js";
import i18n from "../../src/lib/i18n.js";

const STORED_LOCALE_KEY = "opencoo_locale";

afterEach(async () => {
  // Reset i18n + localStorage between tests so the next test's
  // initial state is deterministic. Awaited — leaving the i18next
  // promise unsettled can leak the prior locale into the next test
  // (Copilot review #166).
  if (i18n.language !== "en") {
    await i18n.changeLanguage("en");
  }
  try {
    window.localStorage.removeItem(STORED_LOCALE_KEY);
  } catch {
    // ignore — jsdom always provides localStorage.
  }
  vi.restoreAllMocks();
});

describe("LocaleSwitcher (PR-C2)", () => {
  it("renders a native <select> with English + Polski options", () => {
    render(<LocaleSwitcher onChange={vi.fn()} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option")).map(
      (o) => ({ value: o.value, label: o.textContent }),
    );
    expect(options).toEqual([
      { value: "en", label: "English" },
      { value: "pl", label: "Polski" },
    ]);
  });

  it("pre-selects the current i18n locale (en) on first paint", async () => {
    await i18n.changeLanguage("en");
    render(<LocaleSwitcher onChange={vi.fn()} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("en");
  });

  it("pre-selects 'pl' when i18n is in Polish", async () => {
    await i18n.changeLanguage("pl");
    render(<LocaleSwitcher onChange={vi.fn()} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("pl");
  });

  it("on change: calls i18n.changeLanguage, writes localStorage, fires onChange", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const changeLanguageSpy = vi.spyOn(i18n, "changeLanguage");
    render(<LocaleSwitcher onChange={onChange} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;

    fireEvent.change(select, { target: { value: "pl" } });

    // i18n flipped to pl synchronously (the call site does not
    // await; the next render picks up the new locale via i18next's
    // internal pub/sub).
    expect(changeLanguageSpy).toHaveBeenCalledWith("pl");
    // localStorage is the in-session SoT — written even if the
    // PATCH later fails.
    expect(window.localStorage.getItem(STORED_LOCALE_KEY)).toBe("pl");
    // onChange is the PATCH composer — called with the new locale.
    expect(onChange).toHaveBeenCalledWith("pl");
  });

  it("does NOT regress local state when onChange rejects (server sick)", async () => {
    // Simulate a 422 / 5xx — the switcher should NOT roll back
    // i18n.changeLanguage or localStorage; the operator's choice
    // is respected even when the server cannot persist it.
    const onChange = vi.fn().mockRejectedValue(new Error("422 invalid_locale"));
    const changeLanguageSpy = vi.spyOn(i18n, "changeLanguage");
    // Swallow the expected console.warn in this test (the switcher
    // logs the failed PATCH so an operator triaging client logs sees
    // the silent gap until B7 toast wiring lands).
    vi.spyOn(console, "warn").mockImplementation((): void => undefined);

    render(<LocaleSwitcher onChange={onChange} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "pl" } });

    // Give the rejected promise a microtask tick to settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(changeLanguageSpy).toHaveBeenCalledWith("pl");
    expect(window.localStorage.getItem(STORED_LOCALE_KEY)).toBe("pl");
    // Switcher's controlled `value` follows the i18n locale, so
    // a failed PATCH does not flip it back to 'en'.
    expect(select.value).toBe("pl");
  });

  it("renders option labels from i18n locale.* keys (en + pl parity)", async () => {
    // en.json: locale.en = "English", locale.pl = "Polski".
    // pl.json: same self-language labels so the picker stays
    // identifiable regardless of the current UI locale. The
    // component reads labels via `t(\`locale.${loc}\`)` so the
    // resource bundles are the single source of truth.
    await i18n.changeLanguage("pl");
    render(<LocaleSwitcher onChange={vi.fn()} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const labels = Array.from(select.querySelectorAll("option")).map(
      (o) => o.textContent,
    );
    expect(labels).toEqual(["English", "Polski"]);
  });

  it("reflects an external i18n.changeLanguage (login reconciliation)", async () => {
    // Mirrors `reconcileLocaleAtLogin` flipping i18n from outside
    // the component — the controlled `value` MUST follow because
    // `useTranslation()` re-renders on `languageChanged`. Without
    // this the switcher silently shows the wrong locale until the
    // operator touches it (the Copilot review #166 failure mode).
    await i18n.changeLanguage("en");
    render(<LocaleSwitcher onChange={vi.fn()} />);
    expect(
      (screen.getByRole("combobox") as HTMLSelectElement).value,
    ).toBe("en");

    await act(async () => {
      await i18n.changeLanguage("pl");
    });
    expect(
      (screen.getByRole("combobox") as HTMLSelectElement).value,
    ).toBe("pl");
  });
});

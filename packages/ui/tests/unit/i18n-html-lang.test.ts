/**
 * `<html lang>` ↔ i18n locale sync (PR-W18, phase-a appendix #18).
 *
 * Background: pre-W18 the SPA flipped `i18n.changeLanguage()` and
 * localStorage on every locale flip but left `document.documentElement.lang`
 * at its initial value (English). Screen readers picked the wrong
 * pronunciation engine for the active locale — Polish text rendered
 * with English phonemes (QA Phase-2 finding on `0.1.0-a.15`).
 *
 * Fix: i18n.ts registers a `languageChanged` listener that writes
 * `document.documentElement.lang` on every flip, plus a one-shot
 * write at module load so the boot-detected locale sticks too.
 *
 * Pin matrix:
 *   1. After `i18n.changeLanguage("pl")`, `<html lang>` is "pl".
 *   2. After flipping back to "en", `<html lang>` is "en".
 *   3. Module import sets `<html lang>` to the initial value (the
 *      detected locale — under jsdom that's "en" via the navigator
 *      fallback).
 */
import { afterEach, describe, expect, it } from "vitest";

import i18n from "../../src/lib/i18n.js";

afterEach(async () => {
  if (i18n.language !== "en") {
    await i18n.changeLanguage("en");
  }
});

describe("i18n `<html lang>` sync (PR-W18)", () => {
  it("sets <html lang> at module load to the initial locale", () => {
    // The import side effect runs once when the module is first
    // loaded by another test in the same file; reading the value
    // here proves the one-shot write at the bottom of i18n.ts ran.
    expect(document.documentElement.lang).toBeTruthy();
    expect(["en", "pl"]).toContain(document.documentElement.lang);
  });

  it("updates <html lang> when i18n.changeLanguage flips to pl", async () => {
    await i18n.changeLanguage("pl");
    expect(document.documentElement.lang).toBe("pl");
  });

  it("updates <html lang> when i18n.changeLanguage flips back to en", async () => {
    await i18n.changeLanguage("pl");
    expect(document.documentElement.lang).toBe("pl");
    await i18n.changeLanguage("en");
    expect(document.documentElement.lang).toBe("en");
  });
});

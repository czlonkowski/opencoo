/**
 * @opencoo/shared/prompts — Locale-keyed prompt loader. Bundles
 * Polish + English prompt bodies for the v0.1 ingestion pipelines
 * (classifier today; compiler / lint reuse the same loader in
 * subsequent PRs).
 *
 * Locale fallback (per Q7): `auto` → `en` with a one-time warn.
 * Unknown locales also fall back to `en` with a warn so a typo in
 * `domains.locale` doesn't crash the pipeline.
 */
import { describe, it, expect } from "vitest";

import {
  loadPrompt,
  PROMPT_NAMES,
  PROMPT_LOCALES,
  type PromptName,
  type PromptLocale,
} from "../src/prompts/index.js";

describe("@opencoo/shared/prompts — module shape", () => {
  it("exports loadPrompt as a function", () => {
    expect(typeof loadPrompt).toBe("function");
  });

  it("PROMPT_NAMES is a non-empty const tuple including 'classifier'", () => {
    expect(PROMPT_NAMES.length).toBeGreaterThan(0);
    expect(PROMPT_NAMES).toContain("classifier");
  });

  it("PROMPT_LOCALES includes 'en', 'pl', and 'auto'", () => {
    expect(PROMPT_LOCALES).toContain("en");
    expect(PROMPT_LOCALES).toContain("pl");
    expect(PROMPT_LOCALES).toContain("auto");
  });

  it("type aliases compile against literals", () => {
    const n: PromptName = "classifier";
    const l: PromptLocale = "en";
    expect([n, l]).toEqual(["classifier", "en"]);
  });
});

describe("loadPrompt — bundled prompts", () => {
  it("returns the English classifier prompt for locale='en'", () => {
    const p = loadPrompt({ name: "classifier", locale: "en" });
    expect(typeof p.body).toBe("string");
    expect(p.body.length).toBeGreaterThan(0);
    expect(p.locale).toBe("en");
    expect(p.name).toBe("classifier");
  });

  it("returns the Polish classifier prompt for locale='pl'", () => {
    const p = loadPrompt({ name: "classifier", locale: "pl" });
    expect(typeof p.body).toBe("string");
    expect(p.body.length).toBeGreaterThan(0);
    expect(p.locale).toBe("pl");
  });

  it("locale='auto' falls back to 'en' (Q7)", () => {
    const p = loadPrompt({ name: "classifier", locale: "auto" });
    expect(p.locale).toBe("en");
    expect(p.fallbackApplied).toBe(true);
  });

  it("unknown locale falls back to 'en' (defensive)", () => {
    const p = loadPrompt({
      name: "classifier",
      // Cast to bypass the literal check; the loader has to cope
      // with stored values that drift from the type.
      locale: "klingon" as unknown as PromptLocale,
    });
    expect(p.locale).toBe("en");
    expect(p.fallbackApplied).toBe(true);
  });

  it("fallbackApplied is false for explicit en/pl", () => {
    expect(loadPrompt({ name: "classifier", locale: "en" }).fallbackApplied).toBe(false);
    expect(loadPrompt({ name: "classifier", locale: "pl" }).fallbackApplied).toBe(false);
  });
});

describe("loadPrompt — content invariants", () => {
  it("English classifier prompt anchors the spotlighting contract", () => {
    const p = loadPrompt({ name: "classifier", locale: "en" });
    // The prompt MUST tell the model that <source_content> is
    // untrusted user input. Otherwise downstream injection
    // defenses are weakened.
    expect(p.body.toLowerCase()).toContain("source_content");
    expect(p.body.toLowerCase()).toMatch(/untrusted|do not follow|ignore/);
  });

  it("Polish classifier prompt also anchors the spotlighting contract", () => {
    const p = loadPrompt({ name: "classifier", locale: "pl" });
    expect(p.body.toLowerCase()).toContain("source_content");
    // Same anchor in Polish: 'niezaufan' (untrusted) or
    // 'nie wykonuj' (do not execute) variants.
    expect(p.body.toLowerCase()).toMatch(/niezaufan|nie wykonuj|nie postępuj/);
  });
});

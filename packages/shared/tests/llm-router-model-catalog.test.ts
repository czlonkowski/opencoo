/**
 * Model-catalog tests (PR-Q13 — phase-a appendix #9).
 *
 * The static catalog seeds the LLM-policy editor's model
 * dropdown per provider. The catalog file's keys are typed
 * against `ProviderName` so future PROVIDERS additions force
 * a catalog update at compile time.
 *
 * Pins:
 *  - Every provider in the closed PROVIDERS tuple has an entry.
 *  - The `ollama` arm is deliberately empty (operator pastes
 *    a custom model name in the UI — local models are not
 *    enumerable in advance).
 *  - The catalog is `Readonly` at the type level so callers
 *    cannot mutate the seed list at runtime.
 *  - Each non-empty arm has 3-6 models (the v0.1 most-used
 *    seed-list budget; bigger lists overwhelm operators per
 *    the design-system progressive-disclosure rule).
 */
import { describe, expect, it } from "vitest";

import { MODEL_CATALOG } from "../src/llm-router/model-catalog.js";
import { PROVIDERS, type ProviderName } from "../src/llm-router/llm-policy.js";

describe("model-catalog (PR-Q13)", () => {
  it("contains an entry for every provider in PROVIDERS", () => {
    for (const p of PROVIDERS) {
      expect(MODEL_CATALOG).toHaveProperty(p);
    }
  });

  it("ollama arm is empty by design (operator pastes a custom model)", () => {
    expect(MODEL_CATALOG.ollama).toEqual([]);
  });

  it("azure arm is empty by design (deployment names are operator-specific)", () => {
    expect(MODEL_CATALOG.azure).toEqual([]);
  });

  it.each<ProviderName>(["openai", "anthropic", "google", "openrouter"])(
    "%s arm seeds 3-6 models",
    (provider) => {
      const list = MODEL_CATALOG[provider];
      expect(list.length).toBeGreaterThanOrEqual(3);
      expect(list.length).toBeLessThanOrEqual(6);
    },
  );

  it("each model id is a non-empty string", () => {
    for (const provider of PROVIDERS) {
      for (const model of MODEL_CATALOG[provider]) {
        expect(typeof model).toBe("string");
        expect(model.length).toBeGreaterThan(0);
      }
    }
  });

  it("openrouter seed includes moonshotai/kimi-k2.6 (PR-Q4 reference model)", () => {
    expect(MODEL_CATALOG.openrouter).toContain("moonshotai/kimi-k2.6");
  });
});

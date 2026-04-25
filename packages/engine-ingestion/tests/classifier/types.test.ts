/**
 * Schema-shape pins for `CLASSIFIER_OUTPUT_SCHEMA`. The orchestrator
 * tests cover the runtime path; these tests pin the boundary the
 * Zod schema enforces directly so a drift between schema + prompt
 * fails here, not five layers deep in a corpus replay.
 */
import { describe, expect, it } from "vitest";

import { CLASSIFIER_OUTPUT_SCHEMA } from "../../src/classifier/types.js";

function validBase(): Record<string, unknown> {
  return {
    version: "v1",
    language: "en",
    summary: "ok",
    target_domains: [
      { domain_slug: "test-domain", page_paths: ["strategy/x.md"] },
    ],
    pipelines: ["compile.single-source"],
  };
}

describe("CLASSIFIER_OUTPUT_SCHEMA — summary cap (copilot #17)", () => {
  it("accepts a 200-char summary (the prompt's documented max)", () => {
    const candidate = { ...validBase(), summary: "a".repeat(200) };
    expect(() => CLASSIFIER_OUTPUT_SCHEMA.parse(candidate)).not.toThrow();
  });

  it("REJECTS a 201-char summary — Zod must fail-closed at the prompt's limit", () => {
    const candidate = { ...validBase(), summary: "a".repeat(201) };
    expect(() => CLASSIFIER_OUTPUT_SCHEMA.parse(candidate)).toThrow();
  });

  it("REJECTS a 250-char summary — well past the limit", () => {
    const candidate = { ...validBase(), summary: "x".repeat(250) };
    expect(() => CLASSIFIER_OUTPUT_SCHEMA.parse(candidate)).toThrow();
  });
});

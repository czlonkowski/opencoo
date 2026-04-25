/**
 * `wildcard_bindings` detector — pure unit tests over fixture
 * binding rows. The detector flags bindings whose
 * `allowed_paths` is wildcard-only, subverting the cross-domain
 * write defense (THREAT-MODEL §2 invariant 1).
 */
import { describe, expect, it } from "vitest";

import { detectWildcardBindings } from "../../../src/agents/lint/detectors/wildcard-bindings.js";

describe("detectWildcardBindings", () => {
  it("flags a binding whose allowed_paths is ['**']", () => {
    const findings = detectWildcardBindings([
      {
        id: "11111111-1111-1111-1111-111111111111",
        domainSlug: "exec",
        adapterSlug: "drive",
        allowedPaths: ["**"],
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("wildcard_bindings");
    expect(findings[0]?.severity).toBe("high");
    expect(findings[0]?.scope).toContain("11111111-");
  });

  it("flags a binding whose allowed_paths is empty", () => {
    const findings = detectWildcardBindings([
      {
        id: "abc",
        domainSlug: "exec",
        adapterSlug: "drive",
        allowedPaths: [],
      },
    ]);
    expect(findings).toHaveLength(1);
  });

  it("flags ['*', '**'] as wildcard-only", () => {
    const findings = detectWildcardBindings([
      { id: "abc", domainSlug: "x", adapterSlug: "y", allowedPaths: ["*", "**"] },
    ]);
    expect(findings).toHaveLength(1);
  });

  it("flags ['*.md'] as wildcard-only (broad-glob-only counts)", () => {
    const findings = detectWildcardBindings([
      { id: "abc", domainSlug: "x", adapterSlug: "y", allowedPaths: ["*.md"] },
    ]);
    expect(findings).toHaveLength(1);
  });

  it("does NOT flag a binding with at least one narrow path", () => {
    const findings = detectWildcardBindings([
      {
        id: "abc",
        domainSlug: "exec",
        adapterSlug: "drive",
        allowedPaths: ["projects/q3.md"],
      },
    ]);
    expect(findings).toEqual([]);
  });

  it("does NOT flag a binding with mixed narrow + wildcard paths", () => {
    const findings = detectWildcardBindings([
      {
        id: "abc",
        domainSlug: "exec",
        adapterSlug: "drive",
        allowedPaths: ["projects/**", "specifically.md"],
      },
    ]);
    expect(findings).toEqual([]);
  });

  it("returns empty for empty input", () => {
    expect(detectWildcardBindings([])).toEqual([]);
  });

  it("returns one finding per wildcard-only binding", () => {
    const findings = detectWildcardBindings([
      { id: "a", domainSlug: "x", adapterSlug: "y", allowedPaths: ["**"] },
      { id: "b", domainSlug: "x", adapterSlug: "y", allowedPaths: ["narrow.md"] },
      { id: "c", domainSlug: "x", adapterSlug: "y", allowedPaths: [] },
    ]);
    expect(findings.map((f) => f.scope).sort()).toEqual([
      "binding:a",
      "binding:c",
    ]);
  });
});

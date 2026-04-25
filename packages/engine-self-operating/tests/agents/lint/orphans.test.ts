/**
 * `orphans` detector — flag wiki pages on disk that have no
 * row in `page_citations`. Pure function over the wiki path
 * list + the cited-paths set.
 */
import { describe, expect, it } from "vitest";

import { detectOrphans } from "../../../src/agents/lint/detectors/orphans.js";

describe("detectOrphans", () => {
  it("flags a page on disk with no citation", () => {
    const findings = detectOrphans({
      domainSlug: "exec",
      wikiPaths: ["projects/orphan.md"],
      citedPaths: new Set<string>(),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("orphans");
    expect(findings[0]?.scope).toBe("exec:projects/orphan.md");
  });

  it("does not flag a page that has a citation", () => {
    const findings = detectOrphans({
      domainSlug: "exec",
      wikiPaths: ["projects/cited.md"],
      citedPaths: new Set(["projects/cited.md"]),
    });
    expect(findings).toEqual([]);
  });

  it("exempts index.md (Index Rebuilder owns it)", () => {
    const findings = detectOrphans({
      domainSlug: "exec",
      wikiPaths: ["index.md"],
      citedPaths: new Set<string>(),
    });
    expect(findings).toEqual([]);
  });

  it("exempts worldview.md / log.md / schema.md (Thinker / log writer / Surfacer own these)", () => {
    const findings = detectOrphans({
      domainSlug: "exec",
      wikiPaths: ["worldview.md", "log.md", "schema.md"],
      citedPaths: new Set<string>(),
    });
    expect(findings).toEqual([]);
  });

  it("partitions: cited pages skipped, uncited flagged", () => {
    const findings = detectOrphans({
      domainSlug: "exec",
      wikiPaths: [
        "projects/q3.md",
        "projects/orphan.md",
        "team/eng.md",
      ],
      citedPaths: new Set(["projects/q3.md"]),
    });
    expect(findings.map((f) => f.scope).sort()).toEqual([
      "exec:projects/orphan.md",
      "exec:team/eng.md",
    ]);
  });

  it("returns [] for empty wiki", () => {
    const findings = detectOrphans({
      domainSlug: "exec",
      wikiPaths: [],
      citedPaths: new Set<string>(),
    });
    expect(findings).toEqual([]);
  });
});

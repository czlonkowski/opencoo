/**
 * `prompt_version_drift` detector — flag pages whose newest
 * citation's `prompt_version` lags the loader's current
 * version. Pure function over per-page newest-version
 * aggregations + the canonical version map.
 */
import { describe, expect, it } from "vitest";

import { detectPromptVersionDrift } from "../../../src/agents/lint/detectors/prompt-version-drift.js";

const CURRENT = { compiler: "1.2.0", classifier: "2.0.0" };

describe("detectPromptVersionDrift", () => {
  it("flags a page whose compiler version is behind", () => {
    const findings = detectPromptVersionDrift({
      pages: [
        {
          domainSlug: "exec",
          pagePath: "old.md",
          newestPromptVersion: "1.0.0",
          promptName: "compiler",
        },
      ],
      currentVersions: CURRENT,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("prompt_version_drift");
    expect(findings[0]?.scope).toBe("exec:old.md");
    expect(findings[0]?.detail).toMatchObject({
      promptName: "compiler",
      compiledVersion: "1.0.0",
      currentVersion: "1.2.0",
    });
  });

  it("does not flag a page at the current version", () => {
    const findings = detectPromptVersionDrift({
      pages: [
        {
          domainSlug: "exec",
          pagePath: "fresh.md",
          newestPromptVersion: "1.2.0",
          promptName: "compiler",
        },
      ],
      currentVersions: CURRENT,
    });
    expect(findings).toEqual([]);
  });

  it("skips pages with no compiled version (orphan or pre-stamp)", () => {
    const findings = detectPromptVersionDrift({
      pages: [
        {
          domainSlug: "exec",
          pagePath: "orphan.md",
          newestPromptVersion: null,
          promptName: "compiler",
        },
      ],
      currentVersions: CURRENT,
    });
    expect(findings).toEqual([]);
  });

  it("skips pages whose promptName isn't in the current map", () => {
    const findings = detectPromptVersionDrift({
      pages: [
        {
          domainSlug: "exec",
          pagePath: "x.md",
          newestPromptVersion: "1.0.0",
          promptName: "uncatalogued",
        },
      ],
      currentVersions: CURRENT,
    });
    expect(findings).toEqual([]);
  });

  it("returns one finding per drifted page", () => {
    const findings = detectPromptVersionDrift({
      pages: [
        { domainSlug: "exec", pagePath: "a.md", newestPromptVersion: "1.0.0", promptName: "compiler" },
        { domainSlug: "exec", pagePath: "b.md", newestPromptVersion: "1.2.0", promptName: "compiler" },
        { domainSlug: "hr", pagePath: "c.md", newestPromptVersion: "0.9.0", promptName: "compiler" },
      ],
      currentVersions: CURRENT,
    });
    expect(findings.map((f) => f.scope).sort()).toEqual([
      "exec:a.md",
      "hr:c.md",
    ]);
  });
});

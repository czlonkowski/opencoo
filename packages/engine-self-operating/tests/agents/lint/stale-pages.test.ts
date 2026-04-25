/**
 * `stale_pages` detector — flag pages whose newest citation is
 * older than the threshold. Pure function over already-
 * aggregated rows + a clock + the threshold.
 */
import { describe, expect, it } from "vitest";

import { detectStalePages } from "../../../src/agents/lint/detectors/stale-pages.js";

const NOW = new Date("2026-04-25T00:00:00Z");

function daysAgoIso(d: number): string {
  return new Date(NOW.getTime() - d * 86_400_000).toISOString();
}

describe("detectStalePages", () => {
  it("flags a page older than the threshold", () => {
    const findings = detectStalePages({
      pages: [
        { domainSlug: "exec", pagePath: "old.md", newestCitationAt: daysAgoIso(100) },
      ],
      thresholdDays: 90,
      now: NOW,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("stale_pages");
    expect(findings[0]?.scope).toBe("exec:old.md");
  });

  it("does not flag a page within the threshold", () => {
    const findings = detectStalePages({
      pages: [
        { domainSlug: "exec", pagePath: "fresh.md", newestCitationAt: daysAgoIso(10) },
      ],
      thresholdDays: 90,
      now: NOW,
    });
    expect(findings).toEqual([]);
  });

  it("does not flag a page exactly at the threshold (cutoff is inclusive on the safe side)", () => {
    const findings = detectStalePages({
      pages: [
        { domainSlug: "exec", pagePath: "edge.md", newestCitationAt: daysAgoIso(90) },
      ],
      thresholdDays: 90,
      now: NOW,
    });
    expect(findings).toEqual([]);
  });

  it("upgrades severity to medium when age >= 2× threshold", () => {
    const findings = detectStalePages({
      pages: [
        { domainSlug: "exec", pagePath: "way-old.md", newestCitationAt: daysAgoIso(200) },
      ],
      thresholdDays: 90,
      now: NOW,
    });
    expect(findings[0]?.severity).toBe("medium");
  });

  it("skips pages with no citation (orphans-detector territory)", () => {
    const findings = detectStalePages({
      pages: [
        { domainSlug: "exec", pagePath: "orphan.md", newestCitationAt: null },
      ],
      thresholdDays: 90,
      now: NOW,
    });
    expect(findings).toEqual([]);
  });

  it("ageDays appears in the detail blob", () => {
    const findings = detectStalePages({
      pages: [
        { domainSlug: "exec", pagePath: "x.md", newestCitationAt: daysAgoIso(120) },
      ],
      thresholdDays: 90,
      now: NOW,
    });
    expect(findings[0]?.detail).toMatchObject({ ageDays: 120 });
  });
});

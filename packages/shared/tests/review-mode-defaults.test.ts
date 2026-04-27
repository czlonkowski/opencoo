/**
 * Default review_mode policy table (architecture.md §307 + §364).
 *
 * The Management UI's "+ New binding" modal prefills the
 * review_mode field from this helper so the server and the UI
 * agree without round-trips. Operator can still edit before
 * submit; the helper is the *default*, not a constraint.
 *
 * Locked decisions (this PR's planning turn):
 *   - knowledge + non-transcription adapter → 'auto'
 *   - catalog-workflows → 'auto' (nightly mechanical ingest)
 *   - catalog-skills    → 'approve' (quarterly human gate)
 *   - any *transcription* adapter (fireflies) overrides to
 *     'approve' regardless of domain class — §364 attack-surface
 *     mitigation.
 */
import { describe, expect, it } from "vitest";

import { defaultReviewModeFor } from "../src/source-adapter/review-mode-defaults.js";

describe("defaultReviewModeFor", () => {
  it("knowledge + drive → 'auto'", () => {
    expect(
      defaultReviewModeFor({ adapterSlug: "drive", domainClass: "knowledge" }),
    ).toBe("auto");
  });

  it("knowledge + asana → 'auto'", () => {
    expect(
      defaultReviewModeFor({ adapterSlug: "asana", domainClass: "knowledge" }),
    ).toBe("auto");
  });

  it("knowledge + n8n → 'auto'", () => {
    expect(
      defaultReviewModeFor({ adapterSlug: "n8n", domainClass: "knowledge" }),
    ).toBe("auto");
  });

  it("catalog-workflows + n8n → 'auto' (nightly mechanical)", () => {
    expect(
      defaultReviewModeFor({
        adapterSlug: "n8n",
        domainClass: "catalog-workflows",
      }),
    ).toBe("auto");
  });

  it("catalog-skills + drive → 'approve' (quarterly human gate)", () => {
    expect(
      defaultReviewModeFor({
        adapterSlug: "drive",
        domainClass: "catalog-skills",
      }),
    ).toBe("approve");
  });

  it("knowledge + fireflies → 'approve' (transcription §364 override)", () => {
    expect(
      defaultReviewModeFor({
        adapterSlug: "fireflies",
        domainClass: "knowledge",
      }),
    ).toBe("approve");
  });

  it("catalog-skills + fireflies → 'approve' (both rules agree)", () => {
    expect(
      defaultReviewModeFor({
        adapterSlug: "fireflies",
        domainClass: "catalog-skills",
      }),
    ).toBe("approve");
  });

  it("never returns 'review' — that variant is v2+ inline-edit only", () => {
    // Spot-check every cell of the matrix and assert NONE equal
    // 'review'. v0.1 architecture parks 'review' for v2 inline-edit.
    const adapters = ["drive", "asana", "n8n", "fireflies"] as const;
    const classes = ["knowledge", "catalog-workflows", "catalog-skills"] as const;
    for (const a of adapters) {
      for (const c of classes) {
        expect(
          defaultReviewModeFor({ adapterSlug: a, domainClass: c }),
        ).not.toBe("review");
      }
    }
  });
});

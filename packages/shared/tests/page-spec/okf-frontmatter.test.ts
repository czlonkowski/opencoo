import { describe, expect, it } from "vitest";

import {
  OKF_VERSION,
  okfFrontmatterSchema,
} from "../../src/page-spec/okf-frontmatter.js";

// OKF v0.1 SPEC §4.1: `type` is the only REQUIRED frontmatter field;
// title/description/resource/tags/timestamp are recommended; producers
// MAY include any additional keys and consumers MUST preserve them.
describe("OKF_VERSION", () => {
  it("is the spec version this module targets", () => {
    expect(OKF_VERSION).toBe("0.1");
  });
});

describe("okfFrontmatterSchema", () => {
  it("accepts a minimal concept with a non-empty type", () => {
    const r = okfFrontmatterSchema.safeParse({ type: "Playbook" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.type).toBe("Playbook");
  });

  it("rejects frontmatter with no type", () => {
    expect(okfFrontmatterSchema.safeParse({ title: "x" }).success).toBe(false);
  });

  it("rejects an empty type", () => {
    expect(okfFrontmatterSchema.safeParse({ type: "" }).success).toBe(false);
  });

  it("preserves producer-defined extension keys (opencoo provenance)", () => {
    const r = okfFrontmatterSchema.safeParse({
      type: "Knowledge Page",
      page_path: "strategy/q3.md",
      schema_version: "1.0.0",
      compiled_by_run_id: "run-123",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      const data = r.data as Record<string, unknown>;
      expect(data["page_path"]).toBe("strategy/q3.md");
      expect(data["schema_version"]).toBe("1.0.0");
      expect(data["compiled_by_run_id"]).toBe("run-123");
    }
  });

  it("accepts the recommended fields with correct shapes", () => {
    const r = okfFrontmatterSchema.safeParse({
      type: "BigQuery Table",
      title: "Orders",
      description: "One row per order.",
      resource: "https://example.com/orders",
      tags: ["sales", "orders"],
      timestamp: "2026-05-28T00:00:00Z",
    });
    expect(r.success).toBe(true);
  });

  it("rejects tags that are not a string array", () => {
    expect(
      okfFrontmatterSchema.safeParse({ type: "X", tags: "sales" }).success,
    ).toBe(false);
  });

  it("rejects a whitespace-only type (matches validator trim semantics)", () => {
    expect(okfFrontmatterSchema.safeParse({ type: "   " }).success).toBe(false);
  });

  it("accepts an ISO 8601 timestamp with a UTC offset (OKF §4.1)", () => {
    const r = okfFrontmatterSchema.safeParse({
      type: "X",
      timestamp: "2026-05-28T22:43:59+00:00",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a non-datetime timestamp", () => {
    expect(
      okfFrontmatterSchema.safeParse({ type: "X", timestamp: "last tuesday" })
        .success,
    ).toBe(false);
  });
});

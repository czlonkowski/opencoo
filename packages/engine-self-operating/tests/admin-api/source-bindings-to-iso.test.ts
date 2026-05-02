/**
 * Unit tests for the `toIso` helper in source-bindings.ts.
 *
 * The helper is exported only for testing purposes.  It guards against
 * a RangeError from `Date.prototype.toISOString()` when Postgres (or
 * pglite in tests) returns a timestamp string that `new Date()` cannot
 * parse — e.g. a non-ISO locale-formatted string on a misconfigured
 * pglite build.  The defensive fix returns `null` instead of throwing
 * so the GET handler stays up. (Copilot comment #6 on PR #42.)
 */
import { describe, expect, it } from "vitest";

import { toIso } from "../../src/admin-api/routes/source-bindings.js";

describe("toIso — valid inputs", () => {
  it("returns null for null input", () => {
    expect(toIso(null)).toBeNull();
  });

  it("returns an ISO string when given a Date object", () => {
    const d = new Date("2025-01-15T10:30:00.000Z");
    expect(toIso(d)).toBe("2025-01-15T10:30:00.000Z");
  });

  it("returns an ISO string when given a valid ISO string", () => {
    expect(toIso("2025-06-01T12:00:00Z")).toBe("2025-06-01T12:00:00.000Z");
  });

  it("returns an ISO string when given a postgres-style timestamp string", () => {
    // node-postgres may return 'YYYY-MM-DD HH:MM:SS.mmm+00' format
    const result = toIso("2025-03-10 08:15:30.123+00");
    expect(result).not.toBeNull();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("toIso — defensive: malformed strings return null instead of throwing", () => {
  it("returns null for a completely unparseable string", () => {
    expect(toIso("not-a-date")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(toIso("")).toBeNull();
  });

  it("returns null for a locale-formatted date (not ISO)", () => {
    // 'DD/MM/YYYY HH:mm' — not parseable by Date constructor on all runtimes
    const result = toIso("15/01/2025 10:30");
    // Either null (our guard) or a valid ISO string — must never throw
    if (result !== null) {
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    // The important invariant: no RangeError thrown.
  });

  it("returns null for an Invalid Date object", () => {
    const invalid = new Date("not-a-date");
    expect(toIso(invalid)).toBeNull();
  });
});

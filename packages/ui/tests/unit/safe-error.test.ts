/**
 * `safeErrorMessage` — PR-W8 UI scrub helper.
 *
 * Pin matrix:
 *   1. Error → uses `.message` verbatim.
 *   2. string → uses verbatim.
 *   3. POJO → coerced via String(value).
 *   4. Bearer-token bytes are replaced with `[REDACTED]`.
 *   5. authorization: header values are replaced with `[REDACTED]`.
 *   6. Result is capped at 200 chars (scrub happens before the cap).
 *   7. Hostile `[Symbol.toPrimitive]` → never throws; returns the
 *      `[unstringifiable error value]` marker.
 */
import { describe, expect, it } from "vitest";

import { safeErrorMessage } from "../../src/lib/safe-error.js";

describe("safeErrorMessage", () => {
  it("uses Error.message verbatim when input is an Error", () => {
    expect(safeErrorMessage(new Error("HTTP 504"))).toBe("HTTP 504");
  });

  it("uses string input verbatim", () => {
    expect(safeErrorMessage("plain string")).toBe("plain string");
  });

  it("coerces non-Error / non-string values via String()", () => {
    expect(safeErrorMessage(null)).toBe("null");
    expect(safeErrorMessage(undefined)).toBe("undefined");
    expect(safeErrorMessage(42)).toBe("42");
    expect(safeErrorMessage({})).toBe("[object Object]");
  });

  it("scrubs Bearer-token bytes", () => {
    const out = safeErrorMessage(
      "fetch failed: Bearer abcdef1234567890XYZ in Authorization header",
    );
    expect(out).not.toMatch(/abcdef1234567890XYZ/);
    expect(out).toMatch(/Bearer \[REDACTED\]/);
  });

  it("scrubs authorization: header values", () => {
    const out = safeErrorMessage("Server replied 401 authorization: Bearer.SHORT.TOKEN-XYZ_42");
    expect(out).toMatch(/authorization: \[REDACTED\]/i);
    expect(out).not.toMatch(/SHORT\.TOKEN/);
  });

  it("caps at 200 chars (scrub-then-cap order)", () => {
    const long = "x".repeat(500);
    expect(safeErrorMessage(long)).toHaveLength(200);
  });

  it("never throws on a hostile value with a throwing [Symbol.toPrimitive]", () => {
    const hostile = {
      [Symbol.toPrimitive]: (): never => {
        throw new Error("hostile coercion");
      },
      toString: (): never => {
        throw new Error("hostile toString");
      },
    };
    expect(() => safeErrorMessage(hostile)).not.toThrow();
    expect(safeErrorMessage(hostile)).toBe("[unstringifiable error value]");
  });
});

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

  it("scrubs Bearer scheme case-insensitively (Copilot triage on PR #148)", () => {
    expect(safeErrorMessage("bearer SECRET-TOKEN-XYZ")).toMatch(
      /bearer \[REDACTED\]/i,
    );
    expect(safeErrorMessage("BEARER SECRET-TOKEN-XYZ")).toMatch(
      /BEARER \[REDACTED\]/i,
    );
  });

  it("scrubs Basic auth scheme so base64 credentials don't leak", () => {
    // `Basic <b64>` is the other RFC-7617 scheme. The base64 string
    // can contain `+` and `=` which a strict charset would miss.
    const out = safeErrorMessage(
      "auth failed: Basic dXNlcjpwYXNzd29yZA== bad creds",
    );
    expect(out).not.toMatch(/dXNlcjpwYXNzd29yZA==/);
    expect(out).toMatch(/Basic \[REDACTED\]/);
  });

  it("scrubs authorization: header values up to a delimiter", () => {
    // The redaction must consume the WHOLE value half — including
    // the scheme name and the b64-encoded credential — up to the
    // next header delimiter (comma, semicolon, or newline).
    const out = safeErrorMessage(
      "Server replied 401 authorization: Basic dXNlcjpwYXNz, retry-after: 5",
    );
    expect(out).toMatch(/authorization: \[REDACTED\]/i);
    expect(out).not.toMatch(/dXNlcjpwYXNz/);
    // The non-auth header survives — we're scrubbing the credential
    // half only, not the entire log line.
    expect(out).toMatch(/retry-after: 5/);
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

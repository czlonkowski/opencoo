/**
 * scrubPat — redacts known credential patterns from error strings
 * before they reach API responses or logs. (THREAT-MODEL §3.6
 * invariant 11: no credential bytes in errors.)
 *
 * Patterns covered:
 *   - Asana PAT: `1/` followed by 16+ digits
 *   - Gitea PAT: 40-char hex, often in `Authorization: token <hex>`
 *   - Generic high-entropy token: ≥32 alphanumeric characters
 *   - Bearer token: `Bearer <anything non-space>`
 *
 * Control: ordinary prose passes through unchanged.
 */
import { describe, expect, it } from "vitest";

import { scrubPat } from "../src/scrub/pat-scrub.js";

describe("scrubPat — Asana PAT", () => {
  it("redacts a bare Asana PAT (1/ followed by 16 digits)", () => {
    const s = "failed to call Asana: 1/1234567890123456";
    const result = scrubPat(s);
    expect(result).not.toContain("1/1234567890123456");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts an Asana PAT with more than 16 digits after the slash", () => {
    const s = "token=1/12345678901234567890 was rejected";
    const result = scrubPat(s);
    expect(result).not.toContain("1/12345678901234567890");
    expect(result).toContain("[REDACTED]");
  });

  it("does NOT redact 1/ followed by fewer than 16 digits", () => {
    // e.g. '1/123' is not a PAT; keep it.
    const s = "page 1/123 of results";
    const result = scrubPat(s);
    expect(result).toBe(s);
  });
});

describe("scrubPat — Gitea PAT (40-char hex)", () => {
  it("redacts a 40-char lowercase hex string (bare)", () => {
    const hex = "a".repeat(40);
    const s = `Authorization: token ${hex}`;
    const result = scrubPat(s);
    expect(result).not.toContain(hex);
    expect(result).toContain("[REDACTED]");
  });

  it("redacts a 40-char mixed-case hex string", () => {
    const hex = "Abcdef0123456789".repeat(2) + "Abcdef01";
    const s = `error: token ${hex} is invalid`;
    const result = scrubPat(s);
    expect(result).not.toContain(hex);
    expect(result).toContain("[REDACTED]");
  });

  it("does NOT redact a hex string shorter than 40 chars", () => {
    const s = "id=abcdef1234567890abcdef123456789 found";
    const result = scrubPat(s);
    expect(result).toBe(s);
  });
});

describe("scrubPat — Bearer token", () => {
  it("redacts Bearer <token> with a non-space token value", () => {
    const s = "Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig";
    const result = scrubPat(s);
    expect(result).not.toContain("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts Bearer followed by a short value", () => {
    const s = "Bearer abc123";
    const result = scrubPat(s);
    expect(result).not.toContain("abc123");
    expect(result).toContain("[REDACTED]");
  });
});

describe("scrubPat — generic high-entropy token (≥32 alphanumeric chars)", () => {
  it("redacts a 32-char alphanumeric token", () => {
    const token = "abcdefABCDEF0123456789abcdefABCD";
    const s = `api_key=${token} failed`;
    const result = scrubPat(s);
    expect(result).not.toContain(token);
    expect(result).toContain("[REDACTED]");
  });

  it("redacts a 64-char alphanumeric token", () => {
    const token = "a".repeat(64);
    const s = `key=${token}`;
    const result = scrubPat(s);
    expect(result).not.toContain(token);
    expect(result).toContain("[REDACTED]");
  });

  it("does NOT redact an alphanumeric string shorter than 32 chars", () => {
    const s = "userId=abcDEF0123456789abcDEF012";
    // 31 chars — just under threshold
    const result = scrubPat(s);
    expect(result).toBe(s);
  });
});

describe("scrubPat — control: ordinary prose unchanged", () => {
  it("passes through a message with no credential patterns", () => {
    const s = "Connection refused to postgres at localhost:5432 — check DATABASE_URL.";
    expect(scrubPat(s)).toBe(s);
  });

  it("passes through a number fraction string", () => {
    const s = "read 1/5 pages in 2 seconds";
    expect(scrubPat(s)).toBe(s);
  });

  it("passes through an empty string", () => {
    expect(scrubPat("")).toBe("");
  });
});

describe("scrubPat — multiple redactions in one string", () => {
  it("redacts all matches in the same string", () => {
    const asanaPat = "1/1234567890123456";
    const bearerToken = "Bearer mySecretApiKeyHere";
    const s = `token1=${asanaPat} token2=${bearerToken}`;
    const result = scrubPat(s);
    expect(result).not.toContain(asanaPat);
    expect(result).not.toContain("mySecretApiKeyHere");
    expect(result.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

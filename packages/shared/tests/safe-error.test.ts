/**
 * `safeErrorMessage` — coerce-and-scrub-and-cap helper for log lines.
 *
 * Single source of truth for the scrub-and-cap pattern previously
 * duplicated across 5 sites:
 *   - packages/cli/src/provision/production-composition.ts
 *   - packages/cli/src/commands/agents-fire.ts
 *   - packages/engine-ingestion/src/workers/production-context.ts
 *   - packages/engine-self-operating/src/start.ts
 *   - packages/adapters/automation-n8n-mcp/src/list-templates.ts
 *
 * (PR-N3 / PR-O2 / PR-O3 reviewer feedback; PR-P3 consolidation.)
 *
 * Contract:
 *   - Accepts unknown (Error → .message; string → verbatim;
 *     anything else → String(value)).
 *   - SCRUB FIRST, then cap at ERROR_MESSAGE_MAX_LENGTH (200 chars).
 *     Order matters: cap-first would leave credential bytes that
 *     straddle the 200-char boundary unredacted because the regex
 *     would no longer match the truncated form.
 *   - Pure; never throws; same output for same input.
 */
import { describe, expect, it } from "vitest";

import {
  ERROR_MESSAGE_MAX_LENGTH,
  safeErrorMessage,
} from "../src/scrub/safe-error.js";

describe("safeErrorMessage — input coercion", () => {
  it("scrubs Bearer tokens from string input then caps at 200", () => {
    const s = "request failed: Authorization: Bearer mySecretApiKey1234567890";
    const result = safeErrorMessage(s);
    expect(result).not.toContain("mySecretApiKey1234567890");
    expect(result).toContain("[REDACTED]");
    expect(result.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX_LENGTH);
  });

  it("extracts .message from Error instance + scrubs + caps", () => {
    const err = new Error("upstream rejected token Bearer abcdef0123456789xyz");
    const result = safeErrorMessage(err);
    expect(result).not.toContain("abcdef0123456789xyz");
    expect(result).toContain("[REDACTED]");
    expect(result.startsWith("upstream rejected token")).toBe(true);
  });

  it("falls back to String(value) for non-Error / non-string input", () => {
    // A POJO without a .message field — most likely path is a
    // throw of a plain object or a number from poorly-written
    // upstream code. We must still produce a bounded, scrubbed
    // string rather than crashing.
    const obj = { code: 500, detail: "oops" };
    const result = safeErrorMessage(obj);
    // Default `String({})` is "[object Object]" — that's the
    // contract: we don't introspect non-Error objects.
    expect(result).toBe("[object Object]");
  });

  it("coerces numbers via String(value)", () => {
    const result = safeErrorMessage(42);
    expect(result).toBe("42");
  });

  it("coerces null + undefined safely", () => {
    expect(safeErrorMessage(null)).toBe("null");
    expect(safeErrorMessage(undefined)).toBe("undefined");
  });
});

describe("safeErrorMessage — scrub-then-cap order", () => {
  it("preserves scrub-then-cap order (token straddling 200-char boundary still redacted)", () => {
    // Construct an input that places a 32+ char generic token
    // STARTING at character 195 — it runs through and past the
    // 200-char cap. With the correct scrub-then-cap order the
    // entire token is replaced with `[REDACTED]` BEFORE the
    // slice runs, so the token bytes never appear in the output
    // even though the slice would have cut through the middle of
    // them. With the WRONG order (cap-then-scrub), the 5-byte
    // remnant after slicing would no longer match the regex (too
    // short) and credential bytes would survive in the log line.
    const prefix = "x".repeat(195);
    const credential = "AKIA" + "0123456789ABCDEF".repeat(2); // 36 chars, all base64url
    const input = prefix + credential;
    expect(input.length).toBe(231);

    const result = safeErrorMessage(input);

    expect(result).not.toContain("AKIA");
    expect(result).not.toContain(credential);
    expect(result.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX_LENGTH);
  });

  it("scrubs Asana PAT", () => {
    const s = "asana said: 1/1234567890123456 was rejected";
    const result = safeErrorMessage(s);
    expect(result).not.toContain("1/1234567890123456");
    expect(result).toContain("[REDACTED]");
  });

  it("scrubs Gitea 40-hex PAT", () => {
    const hex = "a".repeat(40);
    const s = `Authorization: token ${hex}`;
    const result = safeErrorMessage(s);
    expect(result).not.toContain(hex);
    expect(result).toContain("[REDACTED]");
  });
});

describe("safeErrorMessage — cap behaviour", () => {
  it("returns input verbatim when shorter than the cap and no patterns match", () => {
    const s = "Connection refused to postgres at localhost:5432";
    expect(safeErrorMessage(s)).toBe(s);
  });

  it("caps a 600-char input with no scrubbable patterns at exactly 200 chars", () => {
    // Use spaces between short words so no 32+ alphanumeric run
    // triggers the generic-token regex. (Plain "x".repeat(600)
    // would itself be scrubbed.)
    const s = "ab cd ef ".repeat(70).slice(0, 600);
    expect(s.length).toBe(600);
    const result = safeErrorMessage(s);
    expect(result.length).toBe(ERROR_MESSAGE_MAX_LENGTH);
    expect(result).toBe(s.slice(0, ERROR_MESSAGE_MAX_LENGTH));
  });

  it("exposes the cap constant as 200", () => {
    expect(ERROR_MESSAGE_MAX_LENGTH).toBe(200);
  });
});

describe("safeErrorMessage — Error subclass behaviour", () => {
  it("uses .message not .errorClass for OpencooError-shaped input", () => {
    // OpencooError extends Error and carries an extra
    // `errorClass` field; safeErrorMessage must read .message
    // (the human-readable string) and ignore .errorClass (the
    // taxonomy tag). Constructing a minimal Error subclass with
    // the same shape avoids a cross-package import.
    class TestOpencooError extends Error {
      readonly errorClass: string;
      constructor(message: string, errorClass: string) {
        super(message);
        this.errorClass = errorClass;
        this.name = "TestOpencooError";
      }
    }
    const err = new TestOpencooError("vault read failed", "transient");
    const result = safeErrorMessage(err);
    expect(result).toBe("vault read failed");
    expect(result).not.toContain("transient");
  });

  it("handles an Error with an empty message", () => {
    expect(safeErrorMessage(new Error(""))).toBe("");
  });
});

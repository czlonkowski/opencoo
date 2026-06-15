import { describe, expect, it } from "vitest";

import {
  REPAIR_INSTRUCTION,
  buildRepairPrompt,
  extractJsonCandidate,
  formatSchemaError,
  isRetryableProviderError,
} from "../src/llm-router/structured-output.js";
import { z } from "zod";

describe("extractJsonCandidate", () => {
  it("returns plain JSON unchanged", () => {
    expect(extractJsonCandidate('{"a":1}')).toBe('{"a":1}');
  });

  it("trims surrounding whitespace", () => {
    expect(extractJsonCandidate('  \n {"a":1}\n  ')).toBe('{"a":1}');
  });

  it("strips a ```json fenced block", () => {
    const fenced = "```json\n{\"a\":1,\"b\":2}\n```";
    expect(extractJsonCandidate(fenced)).toBe('{"a":1,"b":2}');
  });

  it("strips a bare ``` fenced block", () => {
    const fenced = "```\n{\"a\":1}\n```";
    expect(extractJsonCandidate(fenced)).toBe('{"a":1}');
  });

  it("extracts an object embedded in prose", () => {
    const prose = 'Sure! Here is the classification:\n{"category":"doc","priority":2}\nHope that helps.';
    expect(extractJsonCandidate(prose)).toBe('{"category":"doc","priority":2}');
  });

  it("extracts a top-level array embedded in prose", () => {
    const prose = "Result: [1, 2, 3] done";
    expect(extractJsonCandidate(prose)).toBe("[1, 2, 3]");
  });

  it("leaves non-JSON text as-is (best effort)", () => {
    expect(extractJsonCandidate("not json at all")).toBe("not json at all");
  });
});

describe("isRetryableProviderError", () => {
  it("treats 5xx as retryable", () => {
    expect(isRetryableProviderError({ statusCode: 503 })).toBe(true);
    expect(isRetryableProviderError({ statusCode: 500 })).toBe(true);
  });

  it("treats 429 / 408 / 409 as retryable", () => {
    expect(isRetryableProviderError({ statusCode: 429 })).toBe(true);
    expect(isRetryableProviderError({ statusCode: 408 })).toBe(true);
    expect(isRetryableProviderError({ statusCode: 409 })).toBe(true);
  });

  it("treats 4xx auth/bad-request as non-retryable", () => {
    expect(isRetryableProviderError({ statusCode: 401 })).toBe(false);
    expect(isRetryableProviderError({ statusCode: 400 })).toBe(false);
  });

  it("honours an explicit isRetryable flag over statusCode", () => {
    expect(isRetryableProviderError({ isRetryable: true })).toBe(true);
    expect(isRetryableProviderError({ isRetryable: false, statusCode: 503 })).toBe(false);
  });

  it("treats network-level failures as retryable", () => {
    expect(isRetryableProviderError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableProviderError({ message: "read ECONNRESET" })).toBe(true);
  });

  it("unwraps one level of cause", () => {
    expect(isRetryableProviderError({ message: "wrapped", cause: { statusCode: 503 } })).toBe(true);
  });

  it("defaults to non-retryable for unknown errors", () => {
    expect(isRetryableProviderError(new Error("boom"))).toBe(false);
    expect(isRetryableProviderError(null)).toBe(false);
    expect(isRetryableProviderError("nope")).toBe(false);
  });
});

describe("buildRepairPrompt", () => {
  it("includes the original prompt, the bad output, and the error", () => {
    const out = buildRepairPrompt("classify this", '{"wrong":"shape"}', "category: Required");
    expect(out).toContain("classify this");
    expect(out).toContain('{"wrong":"shape"}');
    expect(out).toContain("category: Required");
    expect(out).toContain(REPAIR_INSTRUCTION);
  });
});

describe("formatSchemaError", () => {
  it("renders zod issues as a compact path: message list", () => {
    const schema = z.object({ category: z.string(), priority: z.number() });
    const res = schema.safeParse({ category: "x" });
    expect(res.success).toBe(false);
    if (!res.success) {
      const msg = formatSchemaError(res.error);
      expect(msg).toContain("priority");
    }
  });
});

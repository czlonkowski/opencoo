/**
 * Tests for `validateCron` — wraps `cron-parser` so the dispatcher
 * can reject malformed `agent_instances.schedule_cron` rows at boot
 * with a clear message instead of crashing later when BullMQ
 * actually tries to fire the job (PR-M2, phase-a appendix #5).
 */
import { describe, expect, it } from "vitest";

import { validateCron } from "../../src/scheduler/cron-validate.js";

describe("validateCron", () => {
  it("accepts a 5-field weekday-mornings pattern", () => {
    const result = validateCron("0 8 * * 1-5");
    expect(result.valid).toBe(true);
  });

  it("accepts a daily 7am pattern", () => {
    const result = validateCron("0 7 * * *");
    expect(result.valid).toBe(true);
  });

  it("rejects garbage with a structured error", () => {
    const result = validateCron("not-a-cron");
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.error).toBeTruthy();
    expect(typeof result.error).toBe("string");
  });

  it("rejects empty string", () => {
    const result = validateCron("");
    expect(result.valid).toBe(false);
  });

  it("rejects an out-of-range minute field", () => {
    const result = validateCron("99 * * * *");
    expect(result.valid).toBe(false);
  });

  it("returns a sanitized error message that does not leak the raw exception stack", () => {
    const result = validateCron("totally invalid");
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    // The error should be a single concise line, not a stack trace.
    expect(result.error).not.toMatch(/\n.*at /);
  });
});

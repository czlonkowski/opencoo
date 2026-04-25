/**
 * Engine-scaffold probes (postgres + redis). Both fail-closed:
 * a thrown error from the underlying client surfaces as
 * `{ ok: false, reason }` — the probe NEVER throws.
 */
import { describe, expect, it, vi } from "vitest";

import {
  postgresProbe,
  redisProbe,
} from "../../src/engine-scaffold/index.js";

describe("postgresProbe", () => {
  it("returns ok:true when SELECT 1 resolves", async () => {
    const result = await postgresProbe({ query: vi.fn().mockResolvedValue({}) });
    expect(result).toEqual({ ok: true });
  });

  it("returns ok:false with a reason when query throws", async () => {
    const result = await postgresProbe({
      query: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    expect(result).toEqual({ ok: false, reason: "ECONNREFUSED" });
  });

  it("stringifies non-Error throwables in the reason", async () => {
    const result = await postgresProbe({
      query: vi.fn().mockRejectedValue("string-throw"),
    });
    expect(result).toEqual({ ok: false, reason: "string-throw" });
  });
});

describe("redisProbe", () => {
  it("returns ok:true when PING returns 'PONG'", async () => {
    const result = await redisProbe({
      ping: vi.fn().mockResolvedValue("PONG"),
    });
    expect(result).toEqual({ ok: true });
  });

  it("returns ok:false when PING returns something else", async () => {
    const result = await redisProbe({
      ping: vi.fn().mockResolvedValue("WHAT"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("PONG");
      expect(result.reason).toContain("WHAT");
    }
  });

  it("returns ok:false with a reason when PING throws", async () => {
    const result = await redisProbe({
      ping: vi.fn().mockRejectedValue(new Error("connection refused")),
    });
    expect(result).toEqual({ ok: false, reason: "connection refused" });
  });
});

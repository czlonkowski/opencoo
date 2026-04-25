/**
 * `buildServer` — Fastify with /health (always 200) and /ready
 * (200 on all-probes-ok, 503 on any probe failure).
 */
import { describe, expect, it } from "vitest";

import { buildServer, type ProbeMap } from "../../src/engine-scaffold/index.js";

describe("buildServer — /health", () => {
  it("responds 200 with status:ok regardless of probes", async () => {
    const app = buildServer({ probes: {} });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });
});

describe("buildServer — /ready", () => {
  const okProbes: ProbeMap = {
    postgres: async () => ({ ok: true }),
    redis: async () => ({ ok: true }),
  };

  it("responds 200 with status:ready when every probe is ok", async () => {
    const app = buildServer({ probes: okProbes });
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      probes: { postgres: { ok: true }, redis: { ok: true } },
    });
    await app.close();
  });

  it("responds 503 with status:not_ready when one probe fails", async () => {
    const app = buildServer({
      probes: {
        postgres: async () => ({ ok: false, reason: "ECONNREFUSED" }),
        redis: async () => ({ ok: true }),
      },
    });
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
    const body = response.json() as { status: string };
    expect(body.status).toBe("not_ready");
    await app.close();
  });

  it("treats a thrown probe as failed (fail-closed at the boundary)", async () => {
    const app = buildServer({
      probes: {
        postgres: async () => {
          throw new Error("oops");
        },
        redis: async () => ({ ok: true }),
      },
    });
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
    const body = response.json() as {
      probes: { postgres: { ok: boolean; reason?: string } };
    };
    expect(body.probes.postgres.ok).toBe(false);
    expect(body.probes.postgres.reason).toBe("oops");
    await app.close();
  });
});

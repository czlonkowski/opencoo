/**
 * Fastify HTTP surface — `/health` (no probes, always 200) and
 * `/ready` (runs every probe per request; 200 only when all
 * pass, 503 otherwise).
 *
 * v0.1 cold-starts probes per request — no caching. Reverse proxy
 * gates traffic via the response. Cache the result in v0.2 if
 * /ready latency becomes a problem under load.
 *
 * Probes are passed in via `ProbeMap`; each entry is a
 * `() => Promise<ProbeResult>`. The handler runs them concurrently
 * with `Promise.all` so /ready latency is bounded by the SLOWEST
 * probe, not their sum.
 */
import Fastify, { type FastifyInstance } from "fastify";

import type { ProbeResult } from "./probes/types.js";

export type ProbeFn = () => Promise<ProbeResult>;
export type ProbeMap = Readonly<Record<string, ProbeFn>>;

export interface BuildServerOptions {
  readonly probes: ProbeMap;
  readonly logger?: boolean;
}

interface ReadyResponse {
  readonly status: "ready" | "not_ready";
  readonly probes: Record<string, ProbeResult>;
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  // Disable Fastify's pino-style logger by default — the engine
  // harness has its own @opencoo/shared logger and double-logging
  // is noise. Tests can opt in via `logger: true`.
  const app = Fastify({ logger: options.logger ?? false });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.get("/ready", async (_req, reply) => {
    const results = await Promise.all(
      Object.entries(options.probes).map(
        async ([name, fn]) => [name, await fn()] as const,
      ),
    );
    const allOk = results.every(([, r]) => r.ok);
    const body: ReadyResponse = {
      status: allOk ? "ready" : "not_ready",
      probes: Object.fromEntries(results),
    };
    if (!allOk) {
      reply.code(503);
    }
    return body;
  });

  return app;
}

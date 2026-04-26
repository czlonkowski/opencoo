/**
 * productionServerFactory tests (PR 30 / plan #135).
 *
 * Load-bearing pin: admin-API MUST register BEFORE static-UI.
 * The static-UI plugin installs a `setNotFoundHandler` — if the
 * order flipped, every `/api/admin/*` request would route
 * through the static handler before the admin routes had a
 * chance to match.
 *
 * The test wires a Fastify instance with the production
 * factory, then asserts:
 *   - `/api/admin/_csrf` → 401 (unauthorized — admin-API
 *     handler IS reachable, just rejects without a Bearer)
 *   - `/totally/unknown/path` → 404 from static-UI handler
 *     (NOT from admin-API), confirming static-UI was registered
 *     after admin-API
 */
import { describe, expect, it } from "vitest";
import { ConsoleLogger } from "@opencoo/shared/logger";
import type { FastifyInstance } from "fastify";

import { productionServerFactory } from "../../src/composition/server-factory.js";
import type { GiteaClient } from "../../src/admin-api/auth.js";
import type { EngineConfig } from "../../src/config.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

function fakeConfig(): EngineConfig {
  return {
    databaseUrl: "postgres://x",
    redisUrl: "redis://y",
    port: 8080,
    logLevel: "info",
    nodeEnv: "test",
    // No uiDistPath → static-UI registers the boot-tolerant
    // 503 fallback (still installs a setNotFoundHandler).
  };
}

function fakeGitea(): GiteaClient {
  return {
    async whoami(): Promise<never> {
      throw new Error("test gitea — not invoked in this test");
    },
  };
}

describe("productionServerFactory — registration order", () => {
  it("admin-API routes are reachable (401 without auth) and unknown paths fall through to static-UI", async () => {
    const probes = {
      postgres: async () => ({ ok: true }),
      redis: async () => ({ ok: true }),
    };
    const app = (await productionServerFactory({
      probes,
      config: fakeConfig(),
      logger: silentLogger(),
      // The admin-API only opens the Drizzle handle; it doesn't
      // hit the DB until a route fires that needs it. We pass
      // a pg.Pool stub — its `query` method never gets called
      // because both injected requests are auth-rejected
      // BEFORE the route handler runs.
      pgPool: {} as unknown as Parameters<typeof productionServerFactory>[0]["pgPool"],
      giteaClient: fakeGitea(),
      compositionEnv: {
        adminTeamSlug: "opencoo-admins",
        sessionHmacKey: Buffer.from("test-hmac-32-bytes-aaaaaaaaaaaaaa"),
        giteaBaseUrl: "https://gitea.test",
        llmDebugLog: false,
      },
    })) as unknown as FastifyInstance;

    try {
      // /api/admin/_csrf reachable → admin-API ran BEFORE
      // static-UI. Without a Bearer token, the verifyAdmin
      // preHandler returns 401 (which we expect).
      const csrfRes = await app.inject({
        method: "GET",
        url: "/api/admin/_csrf",
      });
      expect(csrfRes.statusCode).toBe(401);

      // Unknown path → static-UI's setNotFoundHandler returns
      // 404 ({"status":"not_found", path}) because UI_DIST_PATH
      // is unset and the path isn't a SPA route.
      const unknownRes = await app.inject({
        method: "POST", // POST so SPA fallback doesn't apply (only GET).
        url: "/totally/unknown/path",
      });
      expect(unknownRes.statusCode).toBe(404);
      const body = JSON.parse(unknownRes.body) as { status?: string };
      expect(body.status).toBe("not_found");
    } finally {
      await app.close();
    }
  });

  it("post-composition smoke: /health + /ready + admin paths all reachable", async () => {
    // Behavioural smoke test — the load-bearing ordering
    // assertion is in the test above (admin-API runs BEFORE
    // static-UI catches the route). This test just verifies
    // every layer is up after `productionServerFactory` returns.
    // (An actual import-spy on `registerAdminApi` /
    // `registerStaticUi` would require module-level mocking; the
    // behavioural assertion already covers the invariant.)
    const probes = {
      postgres: async () => ({ ok: true }),
      redis: async () => ({ ok: true }),
    };
    const app = (await productionServerFactory({
      probes,
      config: fakeConfig(),
      logger: silentLogger(),
      pgPool: {} as unknown as Parameters<typeof productionServerFactory>[0]["pgPool"],
      giteaClient: fakeGitea(),
      compositionEnv: {
        adminTeamSlug: "opencoo-admins",
        sessionHmacKey: Buffer.from("test-hmac-32-bytes-aaaaaaaaaaaaaa"),
        giteaBaseUrl: "https://gitea.test",
        llmDebugLog: false,
      },
    })) as unknown as FastifyInstance;
    try {
      const healthRes = await app.inject({ method: "GET", url: "/health" });
      const readyRes = await app.inject({ method: "GET", url: "/ready" });
      const csrfRes = await app.inject({ method: "GET", url: "/api/admin/_csrf" });
      expect(healthRes.statusCode).toBe(200);
      expect(readyRes.statusCode).toBe(200);
      // /api/admin/_csrf returns 401 when unauthenticated — proves
      // the admin-API layer is mounted and gating.
      expect(csrfRes.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

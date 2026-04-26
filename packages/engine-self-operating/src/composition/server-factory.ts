/**
 * Production serverFactory — wires admin-API + static-UI in
 * the right order (PR 30 / plan #135).
 *
 * Order matters: `registerAdminApi` MUST run BEFORE
 * `registerStaticUi`. The static-ui middleware installs a
 * `setNotFoundHandler` that catches unknown paths AND maps
 * extension-less non-`/api/` paths to `index.html` (the SPA
 * fallback). If admin-api routes registered AFTER the static
 * UI, the static handler would be set first and Fastify would
 * route `/api/admin/*` requests through it before our admin
 * routes had a chance to match.
 *
 * The explicit ordering pin is verified by the test in
 * `tests/composition/server-factory.test.ts` — it asserts a
 * call-order trace via spies on both `registerAdminApi` and
 * `registerStaticUi`.
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  buildServer,
  type ProbeMap,
  type StartServer,
} from "@opencoo/shared/engine-scaffold";
import type { Logger } from "@opencoo/shared/logger";

import { registerAdminApi } from "../admin-api/index.js";
import type { GiteaClient } from "../admin-api/auth.js";
import type { EngineConfig } from "../config.js";
import { registerStaticUi } from "../static-ui.js";

import type { AdminApiCompositionEnv } from "./env.js";

export interface ProductionServerFactoryArgs {
  readonly probes: ProbeMap;
  readonly config: EngineConfig;
  readonly logger: Logger;
  /** pg pool the boot scaffold opened — re-used by the admin-API
   *  routes. We wrap it in a Drizzle handle here. */
  readonly pgPool: Pool;
  readonly giteaClient: GiteaClient;
  readonly compositionEnv: AdminApiCompositionEnv;
}

export async function productionServerFactory(
  args: ProductionServerFactoryArgs,
): Promise<FastifyInstance & StartServer> {
  const app: FastifyInstance = buildServer({ probes: args.probes });

  // Wrap the existing pg pool in a Drizzle handle so the
  // admin-API + audit-log writers consume the same connection
  // pool that the engine harness opened. Reusing the pool
  // matters: a second pool would run a second auth handshake
  // per-process and bloat connection counts.
  const db = drizzle(args.pgPool);

  // 1. Admin-API FIRST — registers `/api/admin/*` routes BEFORE
  //    the static-ui setNotFoundHandler captures unknown paths.
  await registerAdminApi({
    app,
    db: db as unknown as Parameters<typeof registerAdminApi>[0]["db"],
    giteaClient: args.giteaClient,
    adminTeamSlug: args.compositionEnv.adminTeamSlug,
    sessionHmacKey: args.compositionEnv.sessionHmacKey,
    logger: args.logger,
    llmDebugLog: args.compositionEnv.llmDebugLog,
  });

  // 2. Static-UI LAST — its setNotFoundHandler catches unknown
  //    paths + serves index.html for extension-less non-`/api/`
  //    paths. The handler differentiates `/api/*` from SPA
  //    routes (verified in `static-ui.ts:230-240`), so unknown
  //    `/api/admin/*` paths still 404 cleanly.
  await registerStaticUi(app, {
    ...(args.config.uiDistPath !== undefined
      ? { uiDistPath: args.config.uiDistPath }
      : {}),
    logger: args.logger,
  });

  return app as unknown as FastifyInstance & StartServer;
}

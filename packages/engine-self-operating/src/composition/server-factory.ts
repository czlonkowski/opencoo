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
 * The ordering invariant is verified BEHAVIOURALLY by the test
 * in `tests/composition/server-factory.test.ts`: an unknown POST
 * route resolves to the static-UI's `setNotFoundHandler` (status:
 * "not_found") AND `/api/admin/_csrf` returns 401 (admin-API
 * reachable). If admin-API was registered AFTER static-UI, the
 * static handler would intercept `/api/admin/*` requests and the
 * 401 wouldn't fire. (Spy-on-imports would be more direct but
 * requires module-level mocking; the behavioural assertion
 * already pins the load-bearing invariant.)
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import type { CredentialStore } from "@opencoo/shared/credential-store";
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
import { provisionDomainRepo } from "./gitea-provisioning.js";

export interface ProductionServerFactoryArgs {
  readonly probes: ProbeMap;
  readonly config: EngineConfig;
  readonly logger: Logger;
  /** pg pool the boot scaffold opened — re-used by the admin-API
   *  routes. We wrap it in a Drizzle handle here. */
  readonly pgPool: Pool;
  readonly giteaClient: GiteaClient;
  readonly compositionEnv: AdminApiCompositionEnv;
  /** Phase-a appendix #2 — credential store for the binding-
   *  create flow. Production composition wires the
   *  DrizzleCredentialStore here. When undefined (e.g.
   *  ENCRYPTION_KEY missing at boot), POST
   *  /api/admin/source-bindings returns 500 (composition-
   *  incomplete). */
  readonly credentialStore?: CredentialStore;
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
    ...(args.credentialStore !== undefined
      ? { credentialStore: args.credentialStore }
      : {}),
    provisionOrg: args.compositionEnv.giteaProvisionOrg,
    provisionDomainRepo: async (a) => {
      // The composition root holds the Gitea base URL; the
      // route hands the operator's PAT verbatim.
      return provisionDomainRepo({
        baseUrl: args.compositionEnv.giteaBaseUrl,
        pat: a.pat,
        org: a.org,
        slug: a.slug,
        domainClass: a.domainClass,
        defaultLocale: a.defaultLocale,
      });
    },
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

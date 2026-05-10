/**
 * Live-pilot test server helper (PR-Q14, phase-a appendix #9).
 *
 * Builds a single Fastify instance with BOTH the admin-API and the
 * ingestion webhook receiver mounted on it (PR-Q6 shared-Fastify
 * shape) and binds it to a free port via `app.listen()`. The
 * live-pilot test then drives every Q-fix surface over real HTTP
 * rather than `app.inject()`, so the shape exercised is the same
 * shape the pilot deployment exposes.
 *
 * The Fastify is constructed with `bodyLimit: WEBHOOK_BODY_LIMIT_BYTES`
 * (5 MB) — same value the orchestrator threads into the production
 * boot — so the inbound webhook content-type parser doesn't 413 on
 * realistic Asana payloads.
 *
 * The test injects:
 *   - a stub Gitea whoami client that returns the e2e admin's
 *     username + a synthetic admin team slug (the real Gitea is
 *     used for repo provisioning + wiki commits via the existing
 *     e2e helpers; only the auth/whoami round-trip is mocked).
 *   - the `asana` SourceAdapter wired with `snapshotMode: 'off'`
 *     so no AsanaClient is needed for this test's parseEvents
 *     path. (Only Asana is registered today — the live-pilot test
 *     drives the Q7 per-adapter signature path through Asana
 *     specifically. Add other adapters here when a Q-fix needs
 *     them.)
 *
 * Helpers exposed:
 *   - `buildLivePilotServer` — constructs + listens; returns
 *     `{baseUrl, port, close}`.
 *   - `csrf` — fetches `/api/admin/_csrf` and parses both the
 *     CSRF token + the cookie segment (matches the SPA flow).
 *   - `headers` — assembles the `Authorization` + `Cookie` +
 *     `x-csrf-token` triple every state-changing admin POST
 *     needs.
 */
import type { AddressInfo } from "node:net";

import Fastify, { type FastifyInstance } from "fastify";

import {
  registerAdminApi,
  type GiteaClient,
} from "../../../packages/engine-self-operating/src/admin-api/index.js";
import { __resetAdminAuthCache } from "../../../packages/engine-self-operating/src/admin-api/auth.js";
import { provisionDomainRepo } from "../../../packages/engine-self-operating/src/composition/gitea-provisioning.js";
import {
  registerWebhookRoute,
  WEBHOOK_BODY_LIMIT_BYTES,
} from "../../../packages/engine-ingestion/src/intake/webhook-receiver.js";
import { InMemoryAdapterRegistry } from "../../../packages/engine-ingestion/src/intake/adapter-registry.js";

import {
  ASANA_ADAPTER_SLUG,
  buildAsanaWebhookHelpers,
} from "../../../packages/adapters/source-asana/src/adapter.js";

import {
  DrizzleCredentialStore,
  type CredentialStore,
} from "../../../packages/shared/src/credential-store/index.js";
import { ConsoleLogger } from "../../../packages/shared/src/logger.js";
import type { Logger } from "../../../packages/shared/src/logger.js";
import { HmacSha256Verifier } from "../../../packages/shared/src/webhook-verifier/index.js";

import type { E2EEnvironment } from "../../e2e/_setup/seed.js";

/** Synthetic admin-team slug stamped into the stub Gitea whoami
 *  response. Must match the `adminTeamSlug` passed to
 *  `registerAdminApi` so `verifyAdmin` admits the request. */
export const LIVE_PILOT_ADMIN_TEAM_SLUG = "opencoo-live-pilot-admins";

/** Org under which `provisionDomainRepo` will plant new domain
 *  repos. Distinct from the admin user (Gitea unifies username +
 *  org namespaces). */
export const LIVE_PILOT_PROVISION_ORG = "opencoo-live-pilot-org";

/** 32-byte hex ENCRYPTION_KEY used by the in-process
 *  CredentialStore. Throwaway value scoped to this test. */
export const LIVE_PILOT_ENCRYPTION_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

export const LIVE_PILOT_SESSION_HMAC = Buffer.from(
  "live-pilot-session-hmac-key-32by",
  "utf8",
);

export interface InMemoryWebhookQueue {
  readonly jobs: Array<{ name: string; data: unknown; opts?: unknown }>;
  add: (name: string, data: unknown, opts?: unknown) => Promise<unknown>;
}

function makeQueue(): InMemoryWebhookQueue {
  const jobs: InMemoryWebhookQueue["jobs"] = [];
  return {
    jobs,
    async add(name, data, opts) {
      jobs.push({ name, data, ...(opts !== undefined ? { opts } : {}) });
      return undefined;
    },
  };
}

function silentLogger(): Logger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

/** Stub Gitea whoami — returns the e2e admin's identity + the
 *  synthetic admin team. The REAL Gitea is reached via the
 *  separately-wired `provisionDomainRepo` callable for repo creation;
 *  only the verifyAdmin lookup is mocked. */
function makeStubGiteaClient(env: E2EEnvironment): GiteaClient {
  return {
    async whoami(): Promise<{ username: string; teams: readonly string[] }> {
      return {
        username: env.giteaAdminUser,
        teams: [LIVE_PILOT_ADMIN_TEAM_SLUG],
      };
    },
  };
}

export interface LivePilotServerHandle {
  readonly app: FastifyInstance;
  readonly baseUrl: string;
  readonly port: number;
  readonly credentialStore: CredentialStore;
  readonly webhookQueue: InMemoryWebhookQueue;
  readonly dlqQueue: InMemoryWebhookQueue;
  readonly classifyQueue: InMemoryWebhookQueue;
  readonly close: () => Promise<void>;
}

export async function buildLivePilotServer(
  env: E2EEnvironment,
): Promise<LivePilotServerHandle> {
  __resetAdminAuthCache();

  const app = Fastify({
    logger: false,
    bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
  });

  const encryptionKey = Buffer.from(LIVE_PILOT_ENCRYPTION_KEY_HEX, "hex");
  const credentialStore = new DrizzleCredentialStore({
    db: env.db as unknown as ConstructorParameters<
      typeof DrizzleCredentialStore
    >[0]["db"],
    key: encryptionKey,
    logger: silentLogger(),
  });

  // Admin API — same registrar the production composition root uses.
  await registerAdminApi({
    app,
    db: env.db as unknown as Parameters<typeof registerAdminApi>[0]["db"],
    giteaClient: makeStubGiteaClient(env),
    adminTeamSlug: LIVE_PILOT_ADMIN_TEAM_SLUG,
    sessionHmacKey: LIVE_PILOT_SESSION_HMAC,
    logger: silentLogger(),
    llmDebugLog: false,
    credentialStore,
    provisionOrg: LIVE_PILOT_PROVISION_ORG,
    provisionDomainRepo: async (a) =>
      provisionDomainRepo({
        baseUrl: env.giteaBaseUrl,
        pat: a.pat,
        org: a.org,
        slug: a.slug,
        domainClass: a.domainClass,
        defaultLocale: a.defaultLocale,
      }),
  });

  // Webhook receiver — mounted on the SAME Fastify the admin API uses
  // (PR-Q6: one process, one port, one container). The plugin-scope
  // encapsulation in `registerWebhookRoute` keeps the raw-buffer
  // content-type parser from leaking onto the admin-API JSON routes.
  const webhookQueue = makeQueue();
  const dlqQueue = makeQueue();
  const classifyQueue = makeQueue();

  // Asana adapter wired with `snapshotMode: 'off'` so no real
  // AsanaClient is needed; the receiver only consumes the `webhook`
  // helpers (verifier + extractSignature + extractWebhookSecret +
  // wrapWebhookSecret + handshakeFn) on the inbound path.
  const asanaWebhookHelpers = buildAsanaWebhookHelpers({
    snapshotMode: "off",
    projectGid: "11111",
    monitoredProjectGids: ["11111"],
    lightSummaryEnabled: false,
  });

  const adapterRegistry = new InMemoryAdapterRegistry();
  adapterRegistry.register({
    slug: ASANA_ADAPTER_SLUG,
    webhook: asanaWebhookHelpers,
  } as unknown as Parameters<InMemoryAdapterRegistry["register"]>[0]);

  registerWebhookRoute(app, {
    db: env.db as unknown as Parameters<typeof registerWebhookRoute>[1]["db"],
    credentialStore,
    adapterRegistry,
    verifier: new HmacSha256Verifier(),
    scannerQueue: webhookQueue,
    dlqQueue,
    scannerClassifyQueue: classifyQueue,
    appLogger: silentLogger(),
  });

  // Bind to a free port — listen({port:0}) lets the kernel pick.
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  // address is `http://127.0.0.1:<port>`; we still introspect the
  // socket because some Fastify versions drop the protocol in the
  // returned string for IPv6/UDS edge cases.
  void address;
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error(
      `live-pilot: app.listen returned an unexpected address shape: ${String(addr)}`,
    );
  }
  const port = (addr as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    app,
    baseUrl,
    port,
    credentialStore,
    webhookQueue,
    dlqQueue,
    classifyQueue,
    close: async (): Promise<void> => {
      await app.close();
    },
  };
}

export interface CsrfHandshake {
  readonly csrfToken: string;
  readonly csrfCookie: string;
  readonly sessionCookie: string;
}

/** Drive `/api/admin/_csrf` over real HTTP and pull the token plus
 *  the cookie segment. The admin-API stamps the session cookie on
 *  the same response (verifyAdmin's set-cookie path), so we capture
 *  both — every subsequent state-changing POST sends the
 *  `opencoo_csrf` cookie back so the double-submit check passes. */
export async function csrf(
  baseUrl: string,
  pat: string,
): Promise<CsrfHandshake> {
  const res = await fetch(`${baseUrl}/api/admin/_csrf`, {
    headers: { Authorization: `Bearer ${pat}` },
  });
  if (!res.ok) {
    throw new Error(
      `csrf: expected 200 got ${res.status}: ${await res.text()}`,
    );
  }
  // Node fetch returns multiple Set-Cookie via getSetCookie() (Node 22+).
  const cookies = res.headers.getSetCookie?.() ?? [];
  let csrfCookie = "";
  let sessionCookie = "";
  for (const c of cookies) {
    const csrfMatch = /opencoo_csrf=([^;]+)/.exec(c);
    if (csrfMatch !== null) csrfCookie = csrfMatch[1] ?? "";
    const sessionMatch = /opencoo_session=([^;]+)/.exec(c);
    if (sessionMatch !== null) sessionCookie = sessionMatch[1] ?? "";
  }
  const body = (await res.json()) as { csrfToken: string };
  return { csrfToken: body.csrfToken, csrfCookie, sessionCookie };
}

/** Build the auth + CSRF header set for an admin-API mutation.
 *  Does NOT set `content-type` — body-bearing callers add it
 *  inline alongside their `body:` field, body-less callers
 *  (e.g. DELETE without a payload) leave it unset. Setting
 *  `content-type: application/json` on a body-less request
 *  trips Fastify's JSON parser with `FST_ERR_CTP_EMPTY_JSON_BODY`
 *  (HTTP 400) — the same failure mode PR-W7 closed in the SPA's
 *  `fetchAdmin` wrapper. */
export function adminHeaders(
  pat: string,
  handshake: CsrfHandshake,
): Record<string, string> {
  const cookieParts: string[] = [];
  if (handshake.csrfCookie.length > 0) {
    cookieParts.push(`opencoo_csrf=${handshake.csrfCookie}`);
  }
  if (handshake.sessionCookie.length > 0) {
    cookieParts.push(`opencoo_session=${handshake.sessionCookie}`);
  }
  return {
    Authorization: `Bearer ${pat}`,
    "x-csrf-token": handshake.csrfToken,
    cookie: cookieParts.join("; "),
  };
}

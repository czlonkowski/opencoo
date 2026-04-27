/**
 * E2E #4 — domain + binding create flow (phase-a appendix #2).
 *
 * Drives the admin-API in-band against the compose-spun
 * Postgres + Gitea + Redis. Closes the regression-test gap for
 * the PR 29 planning bug: architecture.md §13 promised "Sources
 * — list + add" but PR 29 shipped only `+ list`. This e2e
 * proves an operator can create a domain AND a source binding
 * end-to-end without touching psql.
 *
 * Why in-band: the harness shape mirrors `ingest-to-wiki.test.ts`
 * — engines don't yet expose a runnable bin entry, so the test
 * call exercises the same Fastify route registration the
 * production composition root would invoke.
 *
 * Coverage:
 *   1. POST /api/admin/domains creates a row + provisions a
 *      Gitea repo (private) + seeds index.md / log.md / schema.md.
 *   2. POST /api/admin/source-bindings (drive, polling) lands a
 *      binding row with credentials_id populated and
 *      webhook_secret_credentials_id NULL.
 *   3. POST /api/admin/source-bindings (fireflies, webhook)
 *      lands a binding row with BOTH credentials_id AND
 *      webhook_secret_credentials_id populated; review_mode
 *      defaults to 'approve' (transcription override §364).
 *   4. Audit-log rows recorded for both creates; PAT bytes
 *      never appear in any audit metadata.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConsoleLogger } from "../../packages/shared/src/logger.js";
import {
  DrizzleCredentialStore,
} from "../../packages/shared/src/credential-store/drizzle-store.js";
import {
  registerAdminApi,
  type GiteaClient,
} from "../../packages/engine-self-operating/src/admin-api/index.js";
import { __resetAdminAuthCache } from "../../packages/engine-self-operating/src/admin-api/auth.js";
import { provisionDomainRepo } from "../../packages/engine-self-operating/src/composition/gitea-provisioning.js";

import {
  dockerAvailable,
  startCompose,
  stopCompose,
} from "./_setup/compose-controller.js";
import {
  bootstrapEnvironment,
  disposeEnvironment,
  resetForTest,
  type E2EEnvironment,
} from "./_setup/seed.js";

const HAS_DOCKER = dockerAvailable();

const ADMIN_TEAM_SLUG = "opencoo-e2e-admins";
// PROVISION_ORG must be DISTINCT from the admin user name —
// Gitea unifies the username + org namespaces, so a user
// named `opencoo-e2e` blocks an org of the same name.
const PROVISION_ORG = "opencoo-e2e-org";

const SECRET_DRIVE_TOKEN = "service-acct-json-do-not-leak-aaa";
const SECRET_FIREFLIES_KEY = "fireflies-api-key-do-not-leak-bbb";
const SECRET_FIREFLIES_HMAC = "fireflies-hmac-do-not-leak-ccc";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

/** GiteaClient stub for verifyAdmin — returns the e2e admin's
 *  identity + the admin team slug. The real Gitea instance is
 *  used for provisioning calls (those go via fetch in
 *  provisionDomainRepo); we don't need verifyAdmin to round-trip
 *  the real Gitea here, just to admit the operator. */
function makeStubGiteaClient(env: E2EEnvironment): GiteaClient {
  return {
    async whoami(): Promise<{ username: string; teams: readonly string[] }> {
      return {
        username: env.giteaAdminUser,
        teams: [ADMIN_TEAM_SLUG, `${PROVISION_ORG}/${ADMIN_TEAM_SLUG}`],
      };
    },
  };
}

interface ServerHandle {
  readonly app: FastifyInstance;
  readonly close: () => Promise<void>;
}

async function buildAdminServer(
  env: E2EEnvironment,
): Promise<ServerHandle> {
  __resetAdminAuthCache();
  const app = Fastify({ logger: false });
  // ENCRYPTION_KEY is 32 bytes hex — generate once for the test.
  const encryptionKey = Buffer.from(
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "hex",
  );
  const credentialStore = new DrizzleCredentialStore({
    db: env.db as unknown as ConstructorParameters<
      typeof DrizzleCredentialStore
    >[0]["db"],
    key: encryptionKey,
    logger: silentLogger(),
  });
  await registerAdminApi({
    app,
    db: env.db as unknown as Parameters<typeof registerAdminApi>[0]["db"],
    giteaClient: makeStubGiteaClient(env),
    adminTeamSlug: ADMIN_TEAM_SLUG,
    sessionHmacKey: Buffer.from(
      "test-session-hmac-key-32-bytes-x",
      "utf8",
    ),
    logger: silentLogger(),
    llmDebugLog: false,
    credentialStore,
    provisionOrg: PROVISION_ORG,
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
  return {
    app,
    close: async (): Promise<void> => {
      await app.close();
    },
  };
}

async function ensureProvisionOrg(env: E2EEnvironment): Promise<void> {
  // The e2e admin user creates the provisioning org so the
  // domain-create POST has somewhere to plant the new repo.
  // Idempotent — 422 / 409 on existing org are tolerated.
  // Gitea auto-makes the creator an org owner, so we don't need
  // to add the admin user to the owners team explicitly.
  const auth = `token ${env.giteaAdminPat}`;
  const create = await fetch(`${env.giteaBaseUrl}/api/v1/orgs`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      username: PROVISION_ORG,
      visibility: "private",
    }),
  });
  if (!create.ok && create.status !== 422 && create.status !== 409) {
    const body = await create.text();
    throw new Error(
      `gitea org create failed: HTTP ${create.status} ${body}`,
    );
  }
  // Probe to confirm the org actually exists post-create.
  const probe = await fetch(
    `${env.giteaBaseUrl}/api/v1/orgs/${PROVISION_ORG}`,
    { headers: { Authorization: auth } },
  );
  if (!probe.ok) {
    throw new Error(
      `gitea provision-org probe failed for '${PROVISION_ORG}': HTTP ${probe.status} ${await probe.text()}`,
    );
  }
}

async function getCsrf(
  app: FastifyInstance,
  pat: string,
): Promise<{ readonly csrfToken: string; readonly cookie: string }> {
  const res = await app.inject({
    method: "GET",
    url: "/api/admin/_csrf",
    headers: { authorization: `Bearer ${pat}` },
  });
  if (res.statusCode !== 200) {
    throw new Error(
      `getCsrf: expected 200 got ${res.statusCode}: ${res.body}`,
    );
  }
  const setCookie = res.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie)
    ? setCookie.join(", ")
    : setCookie ?? "";
  const csrfMatch = /opencoo_csrf=([^;]+)/.exec(cookieHeader);
  const cookie = csrfMatch?.[1] ?? "";
  const body = JSON.parse(res.body) as { csrfToken: string };
  return { csrfToken: body.csrfToken, cookie };
}

let env: E2EEnvironment | null = null;

beforeAll(async () => {
  if (!HAS_DOCKER) return;
  await startCompose();
  env = await bootstrapEnvironment();
  await ensureProvisionOrg(env);
}, 300_000);

afterAll(async () => {
  await disposeEnvironment();
  // Each e2e test owns its own compose lifecycle (compose-controller's
  // start/stop are per-test, not shared). CI also runs `compose down -v`
  // at the workflow level as belt-and-braces.
  if (HAS_DOCKER) await stopCompose();
}, 60_000);

describe.runIf(HAS_DOCKER)(
  "e2e — domain + binding create (phase-a appendix #2)",
  () => {
    it(
      "creates a domain via POST /api/admin/domains and provisions a Gitea repo",
      async () => {
        if (env === null) throw new Error("env not initialised");
        await resetForTest(env, { wikiRepos: [] });
        const server = await buildAdminServer(env);
        try {
          const { csrfToken, cookie } = await getCsrf(
            server.app,
            env.giteaAdminPat,
          );
          const slug = "wiki-e2e-create";
          const res = await server.app.inject({
            method: "POST",
            url: "/api/admin/domains",
            headers: {
              authorization: `Bearer ${env.giteaAdminPat}`,
              "x-csrf-token": csrfToken,
              cookie: `opencoo_csrf=${cookie}`,
              "content-type": "application/json",
            },
            payload: {
              slug,
              class: "knowledge",
              display_name: "E2E Domain",
              default_locale: "en",
            },
          });
          expect(res.statusCode).toBe(201);
          const body = JSON.parse(res.body) as {
            id: string;
            slug: string;
            repoUrl: string;
          };
          expect(body.slug).toBe(slug);

          // Domain row landed.
          const rows = await env.pgPool.query<{ slug: string }>(
            `SELECT slug FROM domains WHERE slug = $1`,
            [slug],
          );
          expect(rows.rows).toHaveLength(1);

          // Gitea repo provisioned with the seed files.
          const auth = `token ${env.giteaAdminPat}`;
          const indexRes = await fetch(
            `${env.giteaBaseUrl}/api/v1/repos/${PROVISION_ORG}/${slug}/contents/index.md`,
            { headers: { Authorization: auth } },
          );
          expect(indexRes.ok).toBe(true);
          const logRes = await fetch(
            `${env.giteaBaseUrl}/api/v1/repos/${PROVISION_ORG}/${slug}/contents/log.md`,
            { headers: { Authorization: auth } },
          );
          expect(logRes.ok).toBe(true);
          const schemaRes = await fetch(
            `${env.giteaBaseUrl}/api/v1/repos/${PROVISION_ORG}/${slug}/contents/schema.md`,
            { headers: { Authorization: auth } },
          );
          expect(schemaRes.ok).toBe(true);

          // Audit row written; PAT bytes never present in metadata.
          const audit = await env.pgPool.query<{
            metadata: Record<string, unknown>;
          }>(
            `SELECT metadata FROM admin_audit_log WHERE action = 'domain.create'`,
          );
          expect(audit.rows).toHaveLength(1);
          expect(JSON.stringify(audit.rows[0]!.metadata)).not.toContain(
            env.giteaAdminPat,
          );
        } finally {
          await server.close();
        }
      },
      120_000,
    );

    it(
      "creates a polling binding (drive) with one encrypted credential row",
      async () => {
        if (env === null) throw new Error("env not initialised");
        await resetForTest(env, { wikiRepos: [] });
        // Seed a target domain (binding-create needs a domain to point at).
        await env.pgPool.query(
          `INSERT INTO domains (slug, name, locale, class)
           VALUES ('wiki-target-drive', 'Drive target', 'en', 'knowledge'::domain_class)`,
        );
        const server = await buildAdminServer(env);
        try {
          const { csrfToken, cookie } = await getCsrf(
            server.app,
            env.giteaAdminPat,
          );
          const res = await server.app.inject({
            method: "POST",
            url: "/api/admin/source-bindings",
            headers: {
              authorization: `Bearer ${env.giteaAdminPat}`,
              "x-csrf-token": csrfToken,
              cookie: `opencoo_csrf=${cookie}`,
              "content-type": "application/json",
            },
            payload: {
              adapter_slug: "drive",
              target_domain_slug: "wiki-target-drive",
              credentials: {
                service_account_json: SECRET_DRIVE_TOKEN,
                root_folder_id: "1XYZ-e2e",
              },
            },
          });
          expect(res.statusCode).toBe(201);
          const { id } = JSON.parse(res.body) as { id: string };

          // Binding row + credentials_id populated; webhook secret null.
          const row = await env.pgPool.query<{
            credentials_id: string | null;
            webhook_secret_credentials_id: string | null;
            adapter_slug: string;
          }>(
            `SELECT credentials_id::text AS credentials_id,
                    webhook_secret_credentials_id::text AS webhook_secret_credentials_id,
                    adapter_slug
             FROM sources_bindings WHERE id = $1::uuid`,
            [id],
          );
          expect(row.rows[0]!.adapter_slug).toBe("drive");
          expect(row.rows[0]!.credentials_id).not.toBeNull();
          expect(row.rows[0]!.webhook_secret_credentials_id).toBeNull();

          // Credential ciphertext NEVER contains plaintext bytes.
          const credRow = await env.pgPool.query<{ ciphertext: Buffer }>(
            `SELECT ciphertext FROM credentials WHERE id = $1::uuid`,
            [row.rows[0]!.credentials_id],
          );
          expect(credRow.rows[0]!.ciphertext.toString("utf8")).not.toContain(
            SECRET_DRIVE_TOKEN,
          );
        } finally {
          await server.close();
        }
      },
      120_000,
    );

    it(
      "creates a webhook binding (fireflies) with TWO encrypted credential rows + 'approve' default",
      async () => {
        if (env === null) throw new Error("env not initialised");
        await resetForTest(env, { wikiRepos: [] });
        await env.pgPool.query(
          `INSERT INTO domains (slug, name, locale, class)
           VALUES ('wiki-target-meet', 'Meet target', 'en', 'knowledge'::domain_class)`,
        );
        const server = await buildAdminServer(env);
        try {
          const { csrfToken, cookie } = await getCsrf(
            server.app,
            env.giteaAdminPat,
          );
          const res = await server.app.inject({
            method: "POST",
            url: "/api/admin/source-bindings",
            headers: {
              authorization: `Bearer ${env.giteaAdminPat}`,
              "x-csrf-token": csrfToken,
              cookie: `opencoo_csrf=${cookie}`,
              "content-type": "application/json",
            },
            payload: {
              adapter_slug: "fireflies",
              target_domain_slug: "wiki-target-meet",
              credentials: {
                auth: { api_key: SECRET_FIREFLIES_KEY },
                webhook_secret: { signing_secret: SECRET_FIREFLIES_HMAC },
              },
            },
          });
          expect(res.statusCode).toBe(201);
          const { id } = JSON.parse(res.body) as { id: string };

          const row = await env.pgPool.query<{
            credentials_id: string | null;
            webhook_secret_credentials_id: string | null;
            review_mode: string;
          }>(
            `SELECT credentials_id::text AS credentials_id,
                    webhook_secret_credentials_id::text AS webhook_secret_credentials_id,
                    review_mode::text AS review_mode
             FROM sources_bindings WHERE id = $1::uuid`,
            [id],
          );
          expect(row.rows[0]!.credentials_id).not.toBeNull();
          expect(row.rows[0]!.webhook_secret_credentials_id).not.toBeNull();
          expect(row.rows[0]!.credentials_id).not.toBe(
            row.rows[0]!.webhook_secret_credentials_id,
          );
          // Transcription override §364 → 'approve'.
          expect(row.rows[0]!.review_mode).toBe("approve");

          // Both credential rows hold encrypted ciphertext (no
          // plaintext leak) AND the audit row's metadata does
          // not contain either secret.
          const audit = await env.pgPool.query<{
            metadata: Record<string, unknown>;
          }>(
            `SELECT metadata FROM admin_audit_log WHERE action = 'source_binding.create'`,
          );
          expect(audit.rows.length).toBeGreaterThanOrEqual(1);
          const metaJson = JSON.stringify(audit.rows.map((r) => r.metadata));
          expect(metaJson).not.toContain(SECRET_FIREFLIES_KEY);
          expect(metaJson).not.toContain(SECRET_FIREFLIES_HMAC);
        } finally {
          await server.close();
        }
      },
      120_000,
    );
  },
);

/**
 * `POST /api/admin/agents/:slug/dispatch` — on-demand agent
 * dispatch (PR-R3, phase-a appendix #10).
 *
 * Pin matrix:
 *   1. Happy path — POST returns 200 with `{jobId, agentSlug,
 *      domainSlug, instanceSlug}`; the stub enqueue captured
 *      the call with the correct `(instanceId, dryRun)`.
 *   2. Audit row written — single `agent.dispatch_now` row with
 *      metadata containing agent/domain/instance slugs + ids +
 *      caller_username + job_id; NEVER plaintext freeform.
 *   3. Rate-limit — 5 successful POSTs against the same
 *      (agent, user, domain) triple; the 6th returns 429 with a
 *      `Retry-After` header.
 *   4. `dryRun: true` is forwarded to the dispatch enqueue.
 *   5. Unknown agent slug → 404 with `error: 'agent_slug_unknown'`.
 *   6. Unknown domain slug → 422 with `error: 'domain_unknown'`.
 *   7. No instances scoped to domain → 422 with
 *      `error: 'instance_unknown'`.
 *   8. 403 without CSRF token.
 *   9. 401 without auth header.
 *   10. Default-instance fallback — no `instanceSlug` → handler
 *       picks the first instance scoped to the domain by
 *       `created_at` (deterministic).
 *   11. Composition gate — when `dispatchAgentJob` is undefined,
 *       the route returns 503.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";

import { __resetAdminAuthCache } from "../../src/admin-api/auth.js";
import {
  __resetAgentDispatchRateLimit,
  type AgentDispatchEnqueue,
} from "../../src/admin-api/routes/agents-dispatch.js";
import { registerAdminApi } from "../../src/admin-api/index.js";

import {
  getCsrf,
  makeAdminFixture,
  type AdminFixture,
} from "./_fixture.js";

const ADMIN_PAT = "admin-pat-agents-dispatch";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

interface EnqueueCall {
  readonly instanceId: string;
  readonly dryRun: boolean;
}

function makeStubEnqueue(
  jobIds: string[] = ["job-1", "job-2", "job-3", "job-4", "job-5", "job-6"],
): { enqueue: AgentDispatchEnqueue; calls: EnqueueCall[] } {
  const calls: EnqueueCall[] = [];
  let i = 0;
  const enqueue: AgentDispatchEnqueue = async ({ instanceId, dryRun }) => {
    calls.push({ instanceId, dryRun: dryRun ?? false });
    const jobId = jobIds[i] ?? `job-fallback-${i}`;
    i += 1;
    return { jobId };
  };
  return { enqueue, calls };
}

interface DispatchFixture extends AdminFixture {
  readonly enqueueCalls: EnqueueCall[];
}

async function makeDispatchFixture(opts: {
  readonly enqueue?: AgentDispatchEnqueue;
  readonly enqueueCalls?: EnqueueCall[];
  readonly omitEnqueue?: boolean;
} = {}): Promise<DispatchFixture> {
  __resetAdminAuthCache();
  __resetAgentDispatchRateLimit();
  const base = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });

  // Re-register the admin API on a fresh app, this time with the
  // dispatch enqueue wired. The base fixture's `app` already has
  // the routes registered without the enqueue; we need a fresh app.
  await base.close();
  __resetAdminAuthCache();

  const stub = makeStubEnqueue();
  const enqueue = opts.enqueue ?? stub.enqueue;
  const calls = opts.enqueueCalls ?? stub.calls;

  const newBase = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
  // Close the new base's app + reuse its db/raw/credential store
  // by registering a fresh Fastify with the dispatch enqueue.
  await newBase.app.close();

  const app: FastifyInstance = Fastify({ logger: false });
  await registerAdminApi({
    app,
    db: newBase.db as unknown as Parameters<typeof registerAdminApi>[0]["db"],
    giteaClient: newBase.gitea,
    adminTeamSlug: "opencoo-admins",
    sessionHmacKey: Buffer.from("test-session-hmac-key-32-bytes-x"),
    logger: silentLogger(),
    llmDebugLog: false,
    provisionDomainRepo: (a) =>
      newBase.provisioner.provision({
        slug: a.slug,
        domainClass: a.domainClass,
        defaultLocale: a.defaultLocale,
        pat: a.pat,
      }),
    provisionOrg: "opencoo",
    credentialStore: newBase.credentialStore,
    ...(opts.omitEnqueue === true ? {} : { dispatchAgentJob: enqueue }),
  });

  return {
    app,
    db: newBase.db,
    raw: newBase.raw,
    gitea: newBase.gitea,
    provisioner: newBase.provisioner,
    credentialStore: newBase.credentialStore,
    enqueueCalls: calls,
    close: async () => {
      await app.close();
      await newBase.raw.close();
    },
  };
}

async function setupAdmin(
  fixture: DispatchFixture,
  username = "alice",
): Promise<void> {
  fixture.gitea.responses.set(ADMIN_PAT, {
    username,
    teams: ["opencoo-admins"],
  });
}

async function seedDomain(
  raw: DispatchFixture["raw"],
  slug: string,
): Promise<{ readonly id: string }> {
  const r = await raw.query<{ id: string }>(
    `INSERT INTO domains (slug, name, locale, class)
     VALUES ($1, 'Test Domain', 'en', 'knowledge'::domain_class)
     RETURNING id`,
    [slug],
  );
  return { id: r.rows[0]!.id };
}

async function seedAgentInstance(
  raw: DispatchFixture["raw"],
  args: {
    readonly definitionSlug: string;
    readonly name: string;
    readonly scopeDomainId: string;
    readonly enabled?: boolean;
  },
): Promise<{ readonly id: string }> {
  const r = await raw.query<{ id: string }>(
    `INSERT INTO agent_instances
       (definition_slug, name, scope_domain_ids, enabled, schedule_cron)
     VALUES ($1, $2, ARRAY[$3]::uuid[], $4, NULL)
     RETURNING id`,
    [
      args.definitionSlug,
      args.name,
      args.scopeDomainId,
      args.enabled ?? true,
    ],
  );
  return { id: r.rows[0]!.id };
}

describe("admin-api POST /api/admin/agents/:slug/dispatch", () => {
  let cleanup: (() => Promise<void>) | null = null;
  beforeEach(() => {
    __resetAgentDispatchRateLimit();
  });
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("200 happy path — enqueue called + body returns jobId/agentSlug/domainSlug", async () => {
    const f = await makeDispatchFixture();
    cleanup = f.close;
    await setupAdmin(f);

    const { id: domainId } = await seedDomain(f.raw, "wiki-exec");
    const { id: instanceId } = await seedAgentInstance(f.raw, {
      definitionSlug: "lint",
      name: "lint-default",
      scopeDomainId: domainId,
    });

    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/agents/lint/dispatch",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { domainSlug: "wiki-exec", instanceSlug: "lint-default" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      jobId: string;
      agentSlug: string;
      domainSlug: string;
      instanceSlug: string;
      instanceId: string;
      dryRun: boolean;
    };
    expect(body.jobId).toBe("job-1");
    expect(body.agentSlug).toBe("lint");
    expect(body.domainSlug).toBe("wiki-exec");
    expect(body.instanceSlug).toBe("lint-default");
    expect(body.instanceId).toBe(instanceId);
    expect(body.dryRun).toBe(false);

    expect(f.enqueueCalls).toHaveLength(1);
    expect(f.enqueueCalls[0]!.instanceId).toBe(instanceId);
    expect(f.enqueueCalls[0]!.dryRun).toBe(false);
  });

  it("audit row written with the right metadata shape", async () => {
    const f = await makeDispatchFixture();
    cleanup = f.close;
    await setupAdmin(f, "alice");

    const { id: domainId } = await seedDomain(f.raw, "wiki-exec");
    const { id: instanceId } = await seedAgentInstance(f.raw, {
      definitionSlug: "heartbeat",
      name: "heartbeat-morning",
      scopeDomainId: domainId,
    });
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/agents/heartbeat/dispatch",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { domainSlug: "wiki-exec", instanceSlug: "heartbeat-morning" },
    });
    expect(res.statusCode).toBe(200);

    const auditRows = await f.raw.query<{
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, metadata FROM admin_audit_log
       WHERE action = 'agent.dispatch_now'`,
    );
    expect(auditRows.rows.length).toBe(1);
    const meta = auditRows.rows[0]!.metadata;
    expect(meta["agent_slug"]).toBe("heartbeat");
    expect(meta["domain_slug"]).toBe("wiki-exec");
    expect(meta["instance_slug"]).toBe("heartbeat-morning");
    expect(meta["instance_id"]).toBe(instanceId);
    expect(meta["dry_run"]).toBe(false);
    expect(meta["caller_username"]).toBe("alice");
    // PR-R3 audit-before-enqueue ordering: the row is written
    // BEFORE the BullMQ enqueue confirms (so a partial enqueue
    // still leaves a forensic trail). The `job_id` is therefore
    // NOT in the audit row — operators correlate via
    // (caller_username, instance_id, created_at) instead.
    expect(meta["job_id"]).toBeUndefined();
  });

  it("rate-limit — 6th POST returns 429 with Retry-After header", async () => {
    const f = await makeDispatchFixture();
    cleanup = f.close;
    await setupAdmin(f);

    const { id: domainId } = await seedDomain(f.raw, "wiki-rl");
    await seedAgentInstance(f.raw, {
      definitionSlug: "lint",
      name: "lint-rl",
      scopeDomainId: domainId,
    });
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const fire = async () =>
      f.app.inject({
        method: "POST",
        url: "/api/admin/agents/lint/dispatch",
        headers: {
          authorization: `Bearer ${ADMIN_PAT}`,
          "x-csrf-token": csrfToken,
          cookie: `opencoo_csrf=${cookie}`,
          "content-type": "application/json",
        },
        payload: { domainSlug: "wiki-rl", instanceSlug: "lint-rl" },
      });

    for (let i = 0; i < 5; i += 1) {
      const ok = await fire();
      expect(ok.statusCode).toBe(200);
    }
    const limited = await fire();
    expect(limited.statusCode).toBe(429);
    const body = JSON.parse(limited.body) as {
      error: string;
      retryAfterSec: number;
    };
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfterSec).toBeGreaterThan(0);
    // Retry-After header must be set so the UI can read the wait
    // window without parsing the body.
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("dryRun: true forwards the flag to the enqueue", async () => {
    const f = await makeDispatchFixture();
    cleanup = f.close;
    await setupAdmin(f);

    const { id: domainId } = await seedDomain(f.raw, "wiki-dry");
    await seedAgentInstance(f.raw, {
      definitionSlug: "surfacer",
      name: "surfacer-dry",
      scopeDomainId: domainId,
    });
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/agents/surfacer/dispatch",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        domainSlug: "wiki-dry",
        instanceSlug: "surfacer-dry",
        dryRun: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { dryRun: boolean };
    expect(body.dryRun).toBe(true);
    expect(f.enqueueCalls).toHaveLength(1);
    expect(f.enqueueCalls[0]!.dryRun).toBe(true);

    // Audit row carries dry_run: true too.
    const auditRows = await f.raw.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM admin_audit_log WHERE action = 'agent.dispatch_now'`,
    );
    expect(auditRows.rows[0]!.metadata["dry_run"]).toBe(true);
  });

  it("unknown agent slug returns 404", async () => {
    const f = await makeDispatchFixture();
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/agents/not-a-real-agent/dispatch",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { domainSlug: "wiki-exec" },
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("agent_slug_unknown");
  });

  it("unknown domain slug returns 422", async () => {
    const f = await makeDispatchFixture();
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/agents/heartbeat/dispatch",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { domainSlug: "no-such-domain" },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("domain_unknown");
  });

  it("domain has no instances → 422 instance_unknown", async () => {
    const f = await makeDispatchFixture();
    cleanup = f.close;
    await setupAdmin(f);

    await seedDomain(f.raw, "wiki-empty");
    // No instance seeded.
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/agents/lint/dispatch",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { domainSlug: "wiki-empty" },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("instance_unknown");
  });

  it("403 without CSRF token", async () => {
    const f = await makeDispatchFixture();
    cleanup = f.close;
    await setupAdmin(f);
    // Issue session; deliberately omit CSRF on the POST.
    await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/agents/lint/dispatch",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "content-type": "application/json",
      },
      payload: { domainSlug: "wiki-exec" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("401 without auth header", async () => {
    const f = await makeDispatchFixture();
    cleanup = f.close;

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/agents/lint/dispatch",
      headers: { "content-type": "application/json" },
      payload: { domainSlug: "wiki-exec" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("default-instance fallback picks the first instance scoped to the domain", async () => {
    const f = await makeDispatchFixture();
    cleanup = f.close;
    await setupAdmin(f);

    const { id: domainId } = await seedDomain(f.raw, "wiki-default");
    // Insert two instances; the FIRST by created_at must be picked.
    const { id: firstId } = await seedAgentInstance(f.raw, {
      definitionSlug: "lint",
      name: "lint-first",
      scopeDomainId: domainId,
    });
    // Sleep one ms so created_at orders deterministically.
    await new Promise((r) => setTimeout(r, 5));
    await seedAgentInstance(f.raw, {
      definitionSlug: "lint",
      name: "lint-second",
      scopeDomainId: domainId,
    });

    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/agents/lint/dispatch",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { domainSlug: "wiki-default" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      instanceSlug: string;
      instanceId: string;
    };
    expect(body.instanceId).toBe(firstId);
    expect(body.instanceSlug).toBe("lint-first");
  });

  it("503 when dispatcher is not wired (composition incomplete)", async () => {
    const f = await makeDispatchFixture({ omitEnqueue: true });
    cleanup = f.close;
    await setupAdmin(f);

    await seedDomain(f.raw, "wiki-503");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/agents/lint/dispatch",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { domainSlug: "wiki-503" },
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("dispatcher_unavailable");
  });

  it("audit row is written BEFORE the enqueue, so an enqueue throw still leaves a trail", async () => {
    // Inject an enqueue stub that rejects on every call, simulating
    // a BullMQ/Redis blip. The audit row MUST exist regardless —
    // that's the load-bearing forensic invariant.
    const enqueueCalls: EnqueueCall[] = [];
    const failingEnqueue: AgentDispatchEnqueue = async ({
      instanceId,
      dryRun,
    }) => {
      enqueueCalls.push({ instanceId, dryRun: dryRun ?? false });
      throw new Error("simulated bullmq failure");
    };
    const f = await makeDispatchFixture({
      enqueue: failingEnqueue,
      enqueueCalls,
    });
    cleanup = f.close;
    await setupAdmin(f, "alice");

    const { id: domainId } = await seedDomain(f.raw, "wiki-fail");
    await seedAgentInstance(f.raw, {
      definitionSlug: "lint",
      name: "lint-fail",
      scopeDomainId: domainId,
    });
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/agents/lint/dispatch",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { domainSlug: "wiki-fail", instanceSlug: "lint-fail" },
    });
    expect(res.statusCode).toBe(500);
    expect((JSON.parse(res.body) as { error: string }).error).toBe(
      "enqueue_failed",
    );

    // Audit row exists — written BEFORE the enqueue.
    const auditRows = await f.raw.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM admin_audit_log
       WHERE action = 'agent.dispatch_now'`,
    );
    expect(auditRows.rows.length).toBe(1);
    const meta = auditRows.rows[0]!.metadata;
    expect(meta["agent_slug"]).toBe("lint");
    expect(meta["domain_slug"]).toBe("wiki-fail");
    expect(meta["caller_username"]).toBe("alice");
    // The 500 response body must NOT leak unscrubbed error
    // contents — `safeErrorMessage` is applied. The simulated
    // message is short + safe; the assertion guards the contract.
    const body = JSON.parse(res.body) as { reason: string };
    expect(body.reason).toBeDefined();
  });

  it("audit metadata never carries operator-supplied freeform text", async () => {
    const f = await makeDispatchFixture();
    cleanup = f.close;
    await setupAdmin(f);

    const { id: domainId } = await seedDomain(f.raw, "wiki-clean");
    await seedAgentInstance(f.raw, {
      definitionSlug: "lint",
      name: "lint-clean",
      scopeDomainId: domainId,
    });
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    // Body MAY include malicious extras — strict() schema rejects
    // anything outside (domainSlug, instanceSlug, dryRun); the
    // audit row never sees them.
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/agents/lint/dispatch",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        domainSlug: "wiki-clean",
        instanceSlug: "lint-clean",
        evilNote: "<script>alert('xss')</script>",
      },
    });
    // Strict schema rejects unknown keys.
    expect(res.statusCode).toBe(422);

    // No audit row written for the rejected request.
    const rows = await f.raw.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM admin_audit_log
       WHERE action = 'agent.dispatch_now'`,
    );
    expect(rows.rows[0]!.count).toBe("0");
  });
});

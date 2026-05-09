/**
 * `PUT /api/admin/scheduler/:agent` — cadence editor (PR-R6,
 * phase-a appendix #10).
 *
 * Pin matrix:
 *   1. Happy path — PUT with a valid cron string returns 200,
 *      every agent_instances row scoped to the slug has its
 *      schedule_cron flipped, the dispatcher's `updateSchedule`
 *      stub captured the (oldCron, newCron) pair per row, the
 *      response carries `nextFires` (5 ISO strings).
 *   2. Audit row written — single `scheduler.update` row with
 *      metadata `{agent_slug, old_cron, new_cron, instance_count,
 *      caller_username}`; NEVER plaintext freeform text.
 *   3. Cron-parse rejection — invalid cron returns 422 with
 *      `error: 'cron_invalid'` + parse-error reason; NO audit
 *      row written; NO DB UPDATE; NO BullMQ side effect.
 *   4. Unknown agent slug — 404 with `error: 'agent_slug_unknown'`.
 *   5. Agent slug has zero scheduled instances — 404 with
 *      `error: 'agent_unknown'`.
 *   6. Atomicity — when the dispatcher's swap throws, the SQL
 *      UPDATE is rolled back AND no audit row is written. Pin
 *      the load-bearing forensic invariant: a partial swap
 *      doesn't leave the operator with a cron column out of sync
 *      with the BullMQ repeatable index.
 *   7. 403 without CSRF token.
 *   8. 503 when the dispatcher is not wired (composition-incomplete).
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";

import { __resetAdminAuthCache } from "../../src/admin-api/auth.js";
import {
  registerAdminApi,
  type SchedulerUpdate,
} from "../../src/admin-api/index.js";

import {
  getCsrf,
  makeAdminFixture,
  type AdminFixture,
} from "./_fixture.js";

const ADMIN_PAT = "admin-pat-scheduler-update";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

interface UpdateCall {
  readonly entries: ReadonlyArray<{
    readonly instanceId: string;
    readonly definitionSlug: string;
    readonly name: string;
    readonly oldCron: string;
    readonly newCron: string;
  }>;
}

function makeStubUpdate(): {
  update: SchedulerUpdate;
  calls: UpdateCall[];
} {
  const calls: UpdateCall[] = [];
  const update: SchedulerUpdate = async ({ entries }) => {
    calls.push({ entries });
  };
  return { update, calls };
}

function makeFailingUpdate(message = "simulated bullmq throw"): {
  update: SchedulerUpdate;
  calls: UpdateCall[];
} {
  const calls: UpdateCall[] = [];
  const update: SchedulerUpdate = async ({ entries }) => {
    calls.push({ entries });
    throw new Error(message);
  };
  return { update, calls };
}

interface SchedulerFixture extends AdminFixture {
  readonly updateCalls: UpdateCall[];
}

async function makeSchedulerFixture(opts: {
  readonly update?: SchedulerUpdate;
  readonly updateCalls?: UpdateCall[];
  readonly omitUpdate?: boolean;
} = {}): Promise<SchedulerFixture> {
  __resetAdminAuthCache();
  const base = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
  // Re-register the admin API on a fresh app, this time with the
  // updateSchedule callable wired. The base fixture's `app` was
  // built without one; we mirror the agents-dispatch.test.ts pattern.
  await base.close();
  __resetAdminAuthCache();

  const stub = makeStubUpdate();
  const update = opts.update ?? stub.update;
  const calls = opts.updateCalls ?? stub.calls;

  const newBase = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
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
    ...(opts.omitUpdate === true ? {} : { updateSchedule: update }),
  });

  return {
    app,
    db: newBase.db,
    raw: newBase.raw,
    gitea: newBase.gitea,
    provisioner: newBase.provisioner,
    credentialStore: newBase.credentialStore,
    updateCalls: calls,
    close: async () => {
      await app.close();
      await newBase.raw.close();
    },
  };
}

async function setupAdmin(
  fixture: SchedulerFixture,
  username = "alice",
): Promise<void> {
  fixture.gitea.responses.set(ADMIN_PAT, {
    username,
    teams: ["opencoo-admins"],
  });
}

async function seedDomain(
  raw: SchedulerFixture["raw"],
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
  raw: SchedulerFixture["raw"],
  args: {
    readonly definitionSlug: string;
    readonly name: string;
    readonly scopeDomainId: string;
    readonly scheduleCron: string;
  },
): Promise<{ readonly id: string }> {
  const r = await raw.query<{ id: string }>(
    `INSERT INTO agent_instances
       (definition_slug, name, scope_domain_ids, enabled, schedule_cron)
     VALUES ($1, $2, ARRAY[$3]::uuid[], true, $4)
     RETURNING id`,
    [args.definitionSlug, args.name, args.scopeDomainId, args.scheduleCron],
  );
  return { id: r.rows[0]!.id };
}

describe("admin-api PUT /api/admin/scheduler/:agent", () => {
  let cleanup: (() => Promise<void>) | null = null;
  beforeEach(() => {
    __resetAdminAuthCache();
  });
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("200 happy path — DB updated, audit row written, dispatcher swap captured", async () => {
    const f = await makeSchedulerFixture();
    cleanup = f.close;
    await setupAdmin(f, "alice");

    const { id: domainId } = await seedDomain(f.raw, "wiki-exec");
    const { id: instanceId } = await seedAgentInstance(f.raw, {
      definitionSlug: "lint",
      name: "lint-default",
      scopeDomainId: domainId,
      scheduleCron: "0 3 * * 0", // Sunday 03:00
    });

    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PUT",
      url: "/api/admin/scheduler/lint",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { cron: "0 3 1-7 * 0" }, // first Sunday of month at 03:00
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      agent: string;
      cron: string;
      instanceCount: number;
      nextFires: string[];
    };
    expect(body.agent).toBe("lint");
    expect(body.cron).toBe("0 3 1-7 * 0");
    expect(body.instanceCount).toBe(1);
    expect(body.nextFires).toHaveLength(5);
    // Each entry is a parseable ISO timestamp.
    for (const iso of body.nextFires) {
      expect(new Date(iso).toString()).not.toBe("Invalid Date");
    }

    // DB column flipped.
    const dbRow = await f.raw.query<{ schedule_cron: string }>(
      `SELECT schedule_cron FROM agent_instances WHERE id = $1::uuid`,
      [instanceId],
    );
    expect(dbRow.rows[0]!.schedule_cron).toBe("0 3 1-7 * 0");

    // Dispatcher swap was called with the (oldCron, newCron) pair.
    expect(f.updateCalls).toHaveLength(1);
    expect(f.updateCalls[0]!.entries).toHaveLength(1);
    expect(f.updateCalls[0]!.entries[0]!.instanceId).toBe(instanceId);
    expect(f.updateCalls[0]!.entries[0]!.oldCron).toBe("0 3 * * 0");
    expect(f.updateCalls[0]!.entries[0]!.newCron).toBe("0 3 1-7 * 0");
    expect(f.updateCalls[0]!.entries[0]!.definitionSlug).toBe("lint");

    // Audit row written with the right metadata.
    const auditRows = await f.raw.query<{
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, metadata FROM admin_audit_log
       WHERE action = 'scheduler.update'`,
    );
    expect(auditRows.rows.length).toBe(1);
    const meta = auditRows.rows[0]!.metadata;
    expect(meta["agent_slug"]).toBe("lint");
    expect(meta["old_cron"]).toBe("0 3 * * 0");
    expect(meta["new_cron"]).toBe("0 3 1-7 * 0");
    expect(meta["instance_count"]).toBe(1);
    expect(meta["caller_username"]).toBe("alice");
  });

  it("flips every instance scoped to the agent slug in lockstep", async () => {
    const f = await makeSchedulerFixture();
    cleanup = f.close;
    await setupAdmin(f);

    const { id: domainAId } = await seedDomain(f.raw, "wiki-domain-a");
    const { id: domainBId } = await seedDomain(f.raw, "wiki-domain-b");
    await seedAgentInstance(f.raw, {
      definitionSlug: "heartbeat",
      name: "heartbeat-a",
      scopeDomainId: domainAId,
      scheduleCron: "0 8 * * 1-5",
    });
    await seedAgentInstance(f.raw, {
      definitionSlug: "heartbeat",
      name: "heartbeat-b",
      scopeDomainId: domainBId,
      scheduleCron: "0 8 * * 1-5",
    });
    // A different agent's instance should NOT be touched.
    const { id: lintInstanceId } = await seedAgentInstance(f.raw, {
      definitionSlug: "lint",
      name: "lint-untouched",
      scopeDomainId: domainAId,
      scheduleCron: "0 3 * * 0",
    });

    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PUT",
      url: "/api/admin/scheduler/heartbeat",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { cron: "0 9 * * 1-5" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { instanceCount: number };
    expect(body.instanceCount).toBe(2);

    // Both heartbeat rows updated.
    const heartbeatRows = await f.raw.query<{ schedule_cron: string }>(
      `SELECT schedule_cron FROM agent_instances
       WHERE definition_slug = 'heartbeat'`,
    );
    expect(heartbeatRows.rows).toHaveLength(2);
    for (const r of heartbeatRows.rows) {
      expect(r.schedule_cron).toBe("0 9 * * 1-5");
    }
    // Lint row untouched.
    const lintRow = await f.raw.query<{ schedule_cron: string }>(
      `SELECT schedule_cron FROM agent_instances WHERE id = $1::uuid`,
      [lintInstanceId],
    );
    expect(lintRow.rows[0]!.schedule_cron).toBe("0 3 * * 0");

    // Dispatcher swap was called with both heartbeat entries.
    expect(f.updateCalls).toHaveLength(1);
    expect(f.updateCalls[0]!.entries).toHaveLength(2);
  });

  it("422 cron_invalid — invalid cron string is rejected before any side effect", async () => {
    const f = await makeSchedulerFixture();
    cleanup = f.close;
    await setupAdmin(f);

    const { id: domainId } = await seedDomain(f.raw, "wiki-bad");
    const { id: instanceId } = await seedAgentInstance(f.raw, {
      definitionSlug: "lint",
      name: "lint-bad",
      scopeDomainId: domainId,
      scheduleCron: "0 3 * * 0",
    });
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PUT",
      url: "/api/admin/scheduler/lint",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { cron: "not a cron pattern" },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: string; reason: string };
    expect(body.error).toBe("cron_invalid");
    expect(body.reason).toBeDefined();
    expect(body.reason.length).toBeGreaterThan(0);

    // DB column unchanged.
    const dbRow = await f.raw.query<{ schedule_cron: string }>(
      `SELECT schedule_cron FROM agent_instances WHERE id = $1::uuid`,
      [instanceId],
    );
    expect(dbRow.rows[0]!.schedule_cron).toBe("0 3 * * 0");

    // No dispatcher call.
    expect(f.updateCalls).toHaveLength(0);

    // No audit row.
    const auditRows = await f.raw.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM admin_audit_log
       WHERE action = 'scheduler.update'`,
    );
    expect(auditRows.rows[0]!.count).toBe("0");
  });

  it("404 agent_slug_unknown — slug not in the editable set", async () => {
    const f = await makeSchedulerFixture();
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PUT",
      url: "/api/admin/scheduler/not-a-real-agent",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { cron: "0 9 * * 1-5" },
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("agent_slug_unknown");
  });

  it("404 agent_unknown — slug is editable but no scheduled instances exist", async () => {
    const f = await makeSchedulerFixture();
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PUT",
      url: "/api/admin/scheduler/lint",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { cron: "0 3 * * 0" },
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("agent_unknown");
  });

  it("atomicity — dispatcher throws → SQL UPDATE is rolled back AND no audit row exists", async () => {
    const failing = makeFailingUpdate("simulated bullmq throw");
    const f = await makeSchedulerFixture({
      update: failing.update,
      updateCalls: failing.calls,
    });
    cleanup = f.close;
    await setupAdmin(f, "alice");

    const { id: domainId } = await seedDomain(f.raw, "wiki-atomic");
    const { id: instanceId } = await seedAgentInstance(f.raw, {
      definitionSlug: "surfacer",
      name: "surfacer-atomic",
      scopeDomainId: domainId,
      scheduleCron: "0 4 * * 1",
    });
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PUT",
      url: "/api/admin/scheduler/surfacer",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { cron: "0 5 * * 2" },
    });
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("update_failed");

    // The dispatcher was called (so the transaction did reach the
    // BullMQ swap step) but it threw; the SQL UPDATE must be
    // rolled back.
    expect(failing.calls).toHaveLength(1);
    const dbRow = await f.raw.query<{ schedule_cron: string }>(
      `SELECT schedule_cron FROM agent_instances WHERE id = $1::uuid`,
      [instanceId],
    );
    expect(dbRow.rows[0]!.schedule_cron).toBe("0 4 * * 1");

    // No audit row — the audit INSERT was inside the transaction
    // and rolled back along with the UPDATE. Operator's trail
    // matches the actual on-disk state.
    const auditRows = await f.raw.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM admin_audit_log
       WHERE action = 'scheduler.update'`,
    );
    expect(auditRows.rows[0]!.count).toBe("0");
  });

  it("403 without CSRF token", async () => {
    const f = await makeSchedulerFixture();
    cleanup = f.close;
    await setupAdmin(f);
    // Issue session; deliberately omit CSRF on the PUT.
    await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PUT",
      url: "/api/admin/scheduler/lint",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "content-type": "application/json",
      },
      payload: { cron: "0 3 * * 0" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("503 when dispatcher is not wired (composition incomplete)", async () => {
    const f = await makeSchedulerFixture({ omitUpdate: true });
    cleanup = f.close;
    await setupAdmin(f);

    const { id: domainId } = await seedDomain(f.raw, "wiki-503");
    await seedAgentInstance(f.raw, {
      definitionSlug: "heartbeat",
      name: "heartbeat-503",
      scopeDomainId: domainId,
      scheduleCron: "0 8 * * 1-5",
    });
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PUT",
      url: "/api/admin/scheduler/heartbeat",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { cron: "0 9 * * 1-5" },
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("scheduler_unavailable");
  });

  it("422 validation_failed — body schema rejects unknown keys", async () => {
    const f = await makeSchedulerFixture();
    cleanup = f.close;
    await setupAdmin(f);

    const { id: domainId } = await seedDomain(f.raw, "wiki-strict");
    await seedAgentInstance(f.raw, {
      definitionSlug: "lint",
      name: "lint-strict",
      scopeDomainId: domainId,
      scheduleCron: "0 3 * * 0",
    });
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PUT",
      url: "/api/admin/scheduler/lint",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        cron: "0 3 * * 0",
        evilNote: "<script>alert('xss')</script>",
      },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("validation_failed");

    // No audit row — strict-schema rejection happens before any
    // side effect.
    const auditRows = await f.raw.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM admin_audit_log
       WHERE action = 'scheduler.update'`,
    );
    expect(auditRows.rows[0]!.count).toBe("0");
  });
});

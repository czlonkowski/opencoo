/**
 * `POST /api/admin/domains/:slug/recompile-worldview` — on-demand
 * worldview recompile (PR-W1, phase-a appendix #13).
 *
 * Pin matrix mirrors PR-Z3 `:id/scan-now`:
 *   1. 202 happy: enqueue called + body returns `{enqueued: true, jobId}`.
 *   2. Audit row 'domain.recompile_worldview' written with slug +
 *      domain_id + trigger_type=manual + caller_username.
 *   3. 400 on invalid slug format.
 *   4. 404 when the slug doesn't exist.
 *   5. 409 when the domain is disabled.
 *   6. 401 without auth header.
 *   7. 403 without CSRF token.
 *   8. 503 when the worldview queue is not wired.
 *   9. 500 + audit-before-enqueue: a queue.add throw leaves the audit
 *      row in place.
 *  10. PR-Y1 receiver-binding regression: route calls `queue.add` as
 *      a method, NOT a detached `const add = queue.add`.
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-recompile-worldview";

interface EnqueueCall {
  readonly name: string;
  readonly data: unknown;
  readonly opts: unknown;
}

function makeQueueMock(
  opts: { readonly addThrows?: Error } = {},
): {
  readonly queue: {
    add(name: string, data: unknown, opts?: unknown): Promise<unknown>;
  };
  readonly calls: EnqueueCall[];
} {
  const calls: EnqueueCall[] = [];
  return {
    calls,
    queue: {
      add: async (name, data, addOpts) => {
        calls.push({ name, data, opts: addOpts });
        if (opts.addThrows !== undefined) throw opts.addThrows;
        return { id: `job-${calls.length}` };
      },
    },
  };
}

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
  username = "alice",
): Promise<void> {
  fixture.gitea.responses.set(ADMIN_PAT, {
    username,
    teams: ["opencoo-admins"],
  });
}

async function seedDomain(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  slug: string,
  opts: { readonly disabled?: boolean } = {},
): Promise<{ readonly domainId: string }> {
  await raw.query(
    `INSERT INTO domains (slug, name, locale, class)
     VALUES ($1, 'Test', 'en', 'knowledge'::domain_class)`,
    [slug],
  );
  if (opts.disabled === true) {
    await raw.query(
      `UPDATE domains SET disabled_at = NOW() WHERE slug = $1`,
      [slug],
    );
  }
  const dr = await raw.query<{ id: string }>(
    `SELECT id FROM domains WHERE slug = $1 LIMIT 1`,
    [slug],
  );
  return { domainId: dr.rows[0]!.id };
}

describe("admin-api POST /api/admin/domains/:slug/recompile-worldview", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("202 happy: enqueue called + body returns {enqueued, jobId}", async () => {
    const mock = makeQueueMock();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      worldviewQueue: mock.queue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-rec-happy");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/domains/wiki-rec-happy/recompile-worldview",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body) as { enqueued: boolean; jobId: string };
    expect(body.enqueued).toBe(true);
    expect(body.jobId).toMatch(/^recompile-worldview-/);
    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0]!;
    expect(call.name).toBe("worldview.compile");
    const data = call.data as {
      domainId: string;
      domainSlug: string;
      triggerType: string;
    };
    expect(data.domainSlug).toBe("wiki-rec-happy");
    expect(data.triggerType).toBe("manual");
    expect((call.opts as { jobId: string }).jobId).toBe(body.jobId);
  });

  it("audit row 'domain.recompile_worldview' written with slug + domain_id + trigger_type + caller_username", async () => {
    const mock = makeQueueMock();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      worldviewQueue: mock.queue,
    });
    cleanup = f.close;
    await setupAdmin(f, "alice");
    const { domainId } = await seedDomain(f.raw, "wiki-rec-audit");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/domains/wiki-rec-audit/recompile-worldview",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(202);
    const auditRows = await f.raw.query<{
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, metadata FROM admin_audit_log
       WHERE action = 'domain.recompile_worldview'`,
    );
    expect(auditRows.rows.length).toBe(1);
    const meta = auditRows.rows[0]!.metadata;
    expect(meta["slug"]).toBe("wiki-rec-audit");
    expect(meta["domain_id"]).toBe(domainId);
    expect(meta["trigger_type"]).toBe("manual");
    expect(meta["caller_username"]).toBe("alice");
  });

  it("400 on invalid slug format", async () => {
    const mock = makeQueueMock();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      worldviewQueue: mock.queue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/domains/BAD_SLUG/recompile-worldview",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_slug" });
  });

  it("404 when the slug doesn't exist", async () => {
    const mock = makeQueueMock();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      worldviewQueue: mock.queue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/domains/nonexistent-slug/recompile-worldview",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("not_found");
    expect(mock.calls).toHaveLength(0);
  });

  it("409 when the domain is disabled (soft-deleted)", async () => {
    const mock = makeQueueMock();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      worldviewQueue: mock.queue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-rec-disabled", { disabled: true });
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/domains/wiki-rec-disabled/recompile-worldview",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe("domain_disabled");
    expect(mock.calls).toHaveLength(0);
  });

  it("401 without auth header", async () => {
    const mock = makeQueueMock();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      worldviewQueue: mock.queue,
    });
    cleanup = f.close;
    await seedDomain(f.raw, "wiki-rec-401");

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/domains/wiki-rec-401/recompile-worldview",
    });
    expect(res.statusCode).toBe(401);
  });

  it("403 without CSRF token", async () => {
    const mock = makeQueueMock();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      worldviewQueue: mock.queue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-rec-403");
    await getCsrf(f, ADMIN_PAT); // issue session, omit CSRF on POST

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/domains/wiki-rec-403/recompile-worldview",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("503 when the worldview queue is not wired (composition incomplete)", async () => {
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      // worldviewQueue deliberately omitted.
    });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-rec-503");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/domains/wiki-rec-503/recompile-worldview",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toBe("worldview_queue_unavailable");

    // Audit row NOT written when the composition-gate fires.
    const auditRows = await f.raw.query<{ action: string }>(
      `SELECT action FROM admin_audit_log
       WHERE action = 'domain.recompile_worldview'`,
    );
    expect(auditRows.rows.length).toBe(0);
  });

  it("500 + audit-before-enqueue: queue.add throw leaves the audit row in place", async () => {
    const mock = makeQueueMock({
      addThrows: new Error("simulated bullmq transport failure"),
    });
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      worldviewQueue: mock.queue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-rec-500");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/domains/wiki-rec-500/recompile-worldview",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe("enqueue_failed");

    const auditRows = await f.raw.query<{
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, metadata FROM admin_audit_log
       WHERE action = 'domain.recompile_worldview'`,
    );
    expect(auditRows.rows.length).toBe(1);
    expect(auditRows.rows[0]!.metadata["slug"]).toBe("wiki-rec-500");
  });
});

describe("admin-api POST /api/admin/domains/:slug/recompile-worldview — receiver-binding regression (PR-Y1)", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (cleanup !== undefined) await cleanup();
    cleanup = undefined;
  });

  it("calls queue.add as a method, NOT a detached function (preserves `this` for BullMQ)", async () => {
    // PR-Y1 lesson: routing through `const enqueue = queue.add` would
    // lose the receiver and BullMQ's real `Queue.add` throws on
    // `this.trace` access. This test asserts the route hits add as
    // a method by giving the mock a `this`-bound field whose read
    // fails when the receiver is detached.
    class QueueWithThis {
      private readonly secret = "bound";
      async add(name: string, data: unknown, opts: unknown): Promise<unknown> {
        void data;
        void opts;
        if (this.secret !== "bound") throw new Error("receiver lost");
        return { id: `job-with-this-${name}` };
      }
    }
    const queue = new QueueWithThis();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      worldviewQueue: queue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-rec-y1");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/domains/wiki-rec-y1/recompile-worldview",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body) as { enqueued: boolean; jobId: string };
    expect(body.enqueued).toBe(true);
    expect(body.jobId).toContain("recompile-worldview-");
  });
});

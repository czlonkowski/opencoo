/**
 * `POST /api/admin/source-bindings/:id/forget` — impact-preview-
 * gated `source forget` (PR-R7, phase-a appendix #10).
 *
 * The Sources row drill-down's "Forget source" action calls this
 * twice: first with `?dryRun=1` to render the impact preview
 * (recompile / delete / citations / cap), then with `?dryRun=0` (or
 * omitted) to execute the forget once the operator ticks the
 * confirmation checkbox.
 *
 * Pin matrix:
 *   1. `?dryRun=1` returns the impact shape and does NOT enqueue any job
 *      and does NOT write an audit row.
 *   2. Two consecutive dry-runs produce IDENTICAL results (no state
 *      mutation between calls).
 *   3. Cap-state surface accurately reflects today's prior deletes
 *      (peek without commit).
 *   4. `?dryRun=0` enqueues the forget job AND writes a
 *      `source_binding.forget` audit row with COUNTS in metadata
 *      (never path lists).
 *   5. Cap-exceeded: when planned deletes + today's used > cap,
 *      `?dryRun=0` returns 409 `daily_cap_exceeded`.
 *   6. 404 for missing binding.
 *   7. 403 without CSRF token.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryDeleteCap } from "@opencoo/shared/wiki-write";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-binding-forget";

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
): Promise<void> {
  fixture.gitea.responses.set(ADMIN_PAT, {
    username: "alice",
    teams: ["opencoo-admins"],
  });
}

interface SeededWorld {
  readonly bindingId: string;
  readonly otherBindingId: string;
  readonly domainId: string;
  readonly domainSlug: string;
}

/** Seed a binding-under-forget + a second "other" binding in the
 *  same domain. The page_citations rows below cover three cases:
 *
 *    `index.md`   — cited by both bindings → recompile (other still cites)
 *    `team-a.md`  — cited only by the binding-under-forget → delete
 *    `team-b.md`  — cited only by the binding-under-forget → delete
 *
 *  The planner result for the binding-under-forget should be:
 *    pagesRecompiled = ["wiki-forget/index.md"]
 *    pagesDeleted    = ["wiki-forget/team-a.md", "wiki-forget/team-b.md"]
 *    citationsRemoved = 3 (one row per cited page) */
async function seedWorld(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
): Promise<SeededWorld> {
  const domainSlug = "wiki-forget";
  await raw.exec(`
    INSERT INTO domains (slug, name)
    VALUES ('${domainSlug}', 'Forget Test')
    ON CONFLICT (slug) DO NOTHING;
  `);
  const dr = await raw.query<{ id: string }>(
    `SELECT id FROM domains WHERE slug = '${domainSlug}' LIMIT 1`,
  );
  const domainId = dr.rows[0]!.id;
  const b1 = await raw.query<{ id: string }>(
    `INSERT INTO sources_bindings (domain_id, adapter_slug, review_mode, enabled)
     VALUES ($1::uuid, 'drive', 'auto'::review_mode, true)
     RETURNING id`,
    [domainId],
  );
  const b2 = await raw.query<{ id: string }>(
    `INSERT INTO sources_bindings (domain_id, adapter_slug, review_mode, enabled)
     VALUES ($1::uuid, 'asana', 'auto'::review_mode, true)
     RETURNING id`,
    [domainId],
  );
  const bindingId = b1.rows[0]!.id;
  const otherBindingId = b2.rows[0]!.id;

  // Citation seed.
  await raw.query(
    `INSERT INTO page_citations (domain_slug, page_path, source_binding_id, source_ref)
     VALUES
       ($1, 'index.md',  $2::uuid, 'doc-1'),
       ($1, 'team-a.md', $2::uuid, 'doc-2'),
       ($1, 'team-b.md', $2::uuid, 'doc-3'),
       ($1, 'index.md',  $3::uuid, 'doc-4')`,
    [domainSlug, bindingId, otherBindingId],
  );

  return { bindingId, otherBindingId, domainId, domainSlug };
}

describe("admin-api POST /api/admin/source-bindings/:id/forget", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("?dryRun=1 returns impact + does NOT enqueue + does NOT write an audit row", async () => {
    const enqueue = vi.fn(async () => undefined);
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      deleteCap: new InMemoryDeleteCap({ dailyLimit: 10 }),
      forgetJobEnqueuer: enqueue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedWorld(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/forget?dryRun=1`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      pagesRecompiled: string[];
      pagesDeleted: string[];
      citationsRemoved: number;
      dailyDeleteCapState: { used: number; cap: number };
    };
    expect(body.pagesRecompiled).toEqual(["wiki-forget/index.md"]);
    expect(body.pagesDeleted).toEqual([
      "wiki-forget/team-a.md",
      "wiki-forget/team-b.md",
    ]);
    expect(body.citationsRemoved).toBe(3);
    expect(body.dailyDeleteCapState).toEqual({ used: 0, cap: 10 });

    expect(enqueue).not.toHaveBeenCalled();
    const auditRows = await f.raw.query(
      `SELECT id FROM admin_audit_log WHERE action = 'source_binding.forget'`,
    );
    expect(auditRows.rows.length).toBe(0);
  });

  it("two consecutive dry-runs return identical results (no state mutation)", async () => {
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      deleteCap: new InMemoryDeleteCap({ dailyLimit: 10 }),
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedWorld(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const headers = {
      authorization: `Bearer ${ADMIN_PAT}`,
      "x-csrf-token": csrfToken,
      cookie: `opencoo_csrf=${cookie}`,
    };

    const r1 = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/forget?dryRun=1`,
      headers,
    });
    const r2 = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/forget?dryRun=1`,
      headers,
    });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r1.body).toEqual(r2.body);
  });

  it("dailyDeleteCapState surfaces today's prior reserve", async () => {
    const cap = new InMemoryDeleteCap({ dailyLimit: 10 });
    // Pre-reserve 4 deletes against today's budget.
    cap.reserve("wiki-forget" as never, 4, new Date());
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      deleteCap: cap,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedWorld(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/forget?dryRun=1`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      dailyDeleteCapState: { used: number; cap: number };
    };
    expect(body.dailyDeleteCapState).toEqual({ used: 4, cap: 10 });
  });

  it("?dryRun=0 enqueues the forget job + writes audit row with COUNTS (no paths)", async () => {
    const enqueue = vi.fn(async () => undefined);
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      deleteCap: new InMemoryDeleteCap({ dailyLimit: 10 }),
      forgetJobEnqueuer: enqueue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedWorld(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/forget?dryRun=0`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(200);

    expect(enqueue).toHaveBeenCalledOnce();
    const enqueueArg = enqueue.mock.calls[0]![0] as {
      bindingId: string;
      domainSlug: string;
      pagesRecompiled: readonly string[];
      pagesDeleted: readonly string[];
    };
    expect(enqueueArg.bindingId).toBe(bindingId);
    expect(enqueueArg.domainSlug).toBe("wiki-forget");
    expect(enqueueArg.pagesDeleted.length).toBe(2);
    expect(enqueueArg.pagesRecompiled.length).toBe(1);

    const auditRows = await f.raw.query<{ action: string; metadata: unknown }>(
      `SELECT action, metadata FROM admin_audit_log WHERE action = 'source_binding.forget'`,
    );
    expect(auditRows.rows.length).toBe(1);
    const meta = auditRows.rows[0]!.metadata as Record<string, unknown>;
    expect(meta["binding_id"]).toBe(bindingId);
    expect(meta["caller_username"]).toBe("alice");
    // Counts only — the path lists must NOT leak into audit metadata
    // (operator-internal page paths can carry naming the audit reader
    // is not authorized to see).
    expect(meta["pages_recompiled"]).toBe(1);
    expect(meta["pages_deleted"]).toBe(2);
    expect(meta["citations_removed"]).toBe(3);
    expect(meta["pages_recompiled_paths"]).toBeUndefined();
    expect(meta["pages_deleted_paths"]).toBeUndefined();
    expect(meta["cap_used_before"]).toBe(0);
    // After the forget, today's used count climbs by `pages_deleted`.
    expect(meta["cap_used_after"]).toBe(2);
  });

  it("?dryRun=0 returns 409 daily_cap_exceeded when planned deletes + today's used > cap", async () => {
    const enqueue = vi.fn(async () => undefined);
    const cap = new InMemoryDeleteCap({ dailyLimit: 3 });
    // 2 reserved + 2 planned deletes = 4 > 3 cap.
    cap.reserve("wiki-forget" as never, 2, new Date());
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      deleteCap: cap,
      forgetJobEnqueuer: enqueue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedWorld(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/forget?dryRun=0`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as {
      error: string;
      dailyDeleteCapState: { used: number; cap: number };
    };
    expect(body.error).toBe("daily_cap_exceeded");
    expect(body.dailyDeleteCapState).toEqual({ used: 2, cap: 3 });
    // The cap-exceeded path must NOT enqueue the forget job and must
    // NOT write an audit row (the audit-write path is gated behind the
    // cap check; a refused forget never happened).
    expect(enqueue).not.toHaveBeenCalled();
    const auditRows = await f.raw.query(
      `SELECT id FROM admin_audit_log WHERE action = 'source_binding.forget'`,
    );
    expect(auditRows.rows.length).toBe(0);
  });

  it("404 when binding id does not exist", async () => {
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      deleteCap: new InMemoryDeleteCap(),
      forgetJobEnqueuer: async () => undefined,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/source-bindings/00000000-0000-0000-0000-000000000000/forget?dryRun=1",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("403 without CSRF token", async () => {
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      deleteCap: new InMemoryDeleteCap(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedWorld(f.raw);
    await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/forget?dryRun=1`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

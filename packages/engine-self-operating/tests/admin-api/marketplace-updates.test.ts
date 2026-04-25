/**
 * Marketplace-updates state-machine tests (PR 28 / plan #128).
 *
 * State-machine: `pending → accepted | skipped`. Anything else → 409.
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
): Promise<void> {
  fixture.gitea.responses.set("admin-pat", {
    username: "alice",
    teams: ["opencoo-admins"],
  });
}

async function seedMarketplaceUpdate(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  status: string = "pending",
  releaseTag: string = "v1.0.0",
): Promise<{ readonly id: string }> {
  const result = await raw.query<{ id: string }>(
    `INSERT INTO marketplace_updates
       (marketplace_source, release_tag, target_commitish, tree_sha, skills_diff, status)
     VALUES ('czlonkowski/n8n-skills', $1, 'abc123', 'def456', '{"added":[]}'::jsonb, $2::marketplace_update_status)
     RETURNING id`,
    [releaseTag, status],
  );
  return { id: result.rows[0]!.id };
}

describe("admin-api marketplace-updates", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("accepts a pending update (happy path) + writes audit row", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedMarketplaceUpdate(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/marketplace-updates/${id}/decision`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { decision: "accept" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string };
    expect(body.status).toBe("accepted");

    const auditRows = await f.raw.query<{ action: string }>(
      `SELECT action FROM admin_audit_log WHERE action = 'marketplace_update.accept'`,
    );
    expect(auditRows.rows.length).toBe(1);
  });

  it("skips a pending update (happy path)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedMarketplaceUpdate(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/marketplace-updates/${id}/decision`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { decision: "skip" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string };
    expect(body.status).toBe("skipped");
  });

  it("returns 409 when accepting an already-accepted update (illegal transition)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedMarketplaceUpdate(f.raw, "accepted");
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/marketplace-updates/${id}/decision`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { decision: "accept" },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: string; current_status: string };
    expect(body.error).toBe("illegal_transition");
    expect(body.current_status).toBe("accepted");
  });

  it("GET /api/admin/marketplace-updates returns only pending rows", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedMarketplaceUpdate(f.raw, "pending", "v1.0.0");
    await seedMarketplaceUpdate(f.raw, "accepted", "v1.1.0");
    await seedMarketplaceUpdate(f.raw, "skipped", "v1.2.0");
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/marketplace-updates",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: Array<{ status: string }> };
    expect(body.rows.length).toBe(1);
    expect(body.rows[0]?.status).toBe("pending");
  });
});

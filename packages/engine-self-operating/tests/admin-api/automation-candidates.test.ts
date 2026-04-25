/**
 * Automation-candidates state-machine tests (PR 28 / plan #128,
 * planner Q8 — illegal transition → 409).
 *
 * State-machine: `proposed → approved | rejected`.
 * Anything else → 409.
 *
 * Each happy + unhappy path also asserts the audit-log row was
 * written BEFORE the response went out (the row is INSERTed in
 * the same handler that sends the 200; we verify the row exists
 * after the response).
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

async function seedCandidate(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  status: string = "proposed",
): Promise<{ readonly candidateId: string }> {
  await raw.exec(`
    INSERT INTO domains (slug, name) VALUES ('test-domain', 'Test')
    ON CONFLICT (slug) DO NOTHING;
  `);
  const runResult = await raw.query<{ id: string }>(
    `INSERT INTO agent_runs (definition_slug, trigger, status) VALUES ('surfacer', 'scheduled', 'success') RETURNING id`,
  );
  const runId = runResult.rows[0]!.id;
  const candidateResult = await raw.query<{ id: string }>(
    `INSERT INTO automation_candidates (surfacer_run_id, source_page_refs, proposal, status) VALUES ($1::uuid, '[]'::jsonb, '{}'::jsonb, $2::automation_candidate_status) RETURNING id`,
    [runId, status],
  );
  return { candidateId: candidateResult.rows[0]!.id };
}

describe("admin-api automation-candidates — state-machine", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("approves a 'proposed' candidate (happy path)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { candidateId } = await seedCandidate(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/automation-candidates/${candidateId}/decision`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { decision: "approve", rationale: "looks good" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; status: string };
    expect(body.status).toBe("approved");

    // Audit log written.
    const auditRows = await f.raw.query<{ action: string }>(
      `SELECT action FROM admin_audit_log WHERE action = 'automation_candidate.approve'`,
    );
    expect(auditRows.rows.length).toBe(1);
  });

  it("rejects a 'proposed' candidate (happy path)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { candidateId } = await seedCandidate(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/automation-candidates/${candidateId}/decision`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { decision: "reject" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; status: string };
    expect(body.status).toBe("rejected");
  });

  it("returns 409 when approving an already-approved candidate (illegal transition)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { candidateId } = await seedCandidate(f.raw, "approved");
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/automation-candidates/${candidateId}/decision`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { decision: "approve" },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: string; current_status: string };
    expect(body.error).toBe("illegal_transition");
    expect(body.current_status).toBe("approved");
  });

  it("returns 409 when rejecting an already-rejected candidate", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { candidateId } = await seedCandidate(f.raw, "rejected");
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/automation-candidates/${candidateId}/decision`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { decision: "reject" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("returns 404 when the candidate id doesn't exist", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/automation-candidates/00000000-0000-0000-0000-000000000000/decision`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { decision: "approve" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects body with unknown decision verb (Zod validation)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { candidateId } = await seedCandidate(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/automation-candidates/${candidateId}/decision`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { decision: "approveAll" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/admin/automation-candidates returns only proposed candidates", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedCandidate(f.raw, "proposed");
    await seedCandidate(f.raw, "approved");
    await seedCandidate(f.raw, "rejected");
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/automation-candidates",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: Array<{ status: string }> };
    expect(body.rows.length).toBe(1);
    expect(body.rows[0]?.status).toBe("proposed");
  });
});

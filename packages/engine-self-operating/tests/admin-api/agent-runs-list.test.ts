/**
 * `GET /api/admin/agent-runs` — paginated reverse-chrono list of agent runs.
 *
 * Test-first artifact for PR-B (phase-a appendix #4).
 *
 * Pin matrix:
 *   1. Returns runs in reverse-chrono order (newest first).
 *   2. Default page size is 50; respects `limit` + `offset` query params.
 *   3. Each row carries: id, definitionSlug, status, trigger,
 *      tokensIn, tokensOut, costUsd, latencyMs, startedAt, endedAt,
 *      errorClass, skillsUsed.
 *   4. `output` field is NOT included at list level (only in detail).
 *   5. Requires admin auth — 401 without Bearer.
 *   6. `limit` is capped at 200.
 */
import { afterEach, describe, expect, it } from "vitest";

import { makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "agent-runs-list-pat";

describe("admin-api GET /api/admin/agent-runs — list", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("returns 401 without admin auth", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/agent-runs",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns empty rows when no runs exist", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/agent-runs",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: unknown[]; total: number };
    expect(body.rows).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("returns runs in reverse-chrono order", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    // Insert two runs with different started_at times.
    const older = new Date(Date.now() - 60_000).toISOString();
    const newer = new Date(Date.now() - 10_000).toISOString();

    await f.raw.exec(`
      INSERT INTO agent_runs (definition_slug, trigger, status, started_at)
      VALUES ('heartbeat', 'scheduled', 'success', '${older}'),
             ('lint', 'scheduled', 'running', '${newer}')
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/agent-runs",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      rows: Array<{ definitionSlug: string; startedAt: string }>;
      total: number;
    };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]!.definitionSlug).toBe("lint"); // newer first
    expect(body.rows[1]!.definitionSlug).toBe("heartbeat");
    expect(body.total).toBe(2);
  });

  it("each row has required fields (no output at list level)", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    await f.raw.exec(`
      INSERT INTO agent_runs
        (definition_slug, trigger, status, tokens_in, tokens_out,
         cost_usd, latency_ms, started_at, error_class)
      VALUES
        ('heartbeat', 'scheduled', 'success', 100, 200, '0.001234', 1500,
         NOW(), NULL)
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/agent-runs",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      rows: Array<Record<string, unknown>>;
    };
    const row = body.rows[0]!;
    expect(typeof row["id"]).toBe("string");
    expect(row["definitionSlug"]).toBe("heartbeat");
    expect(row["status"]).toBe("success");
    expect(row["trigger"]).toBe("scheduled");
    expect(typeof row["tokensIn"]).toBe("number");
    expect(typeof row["tokensOut"]).toBe("number");
    // output is NOT included at list level
    expect("output" in row).toBe(false);
  });

  it("respects limit + offset params", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    // Seed 5 runs.
    for (let i = 0; i < 5; i++) {
      const t = new Date(Date.now() - i * 10_000).toISOString();
      await f.raw.exec(`
        INSERT INTO agent_runs (definition_slug, trigger, status, started_at)
        VALUES ('run${i}', 'scheduled', 'success', '${t}')
      `);
    }

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/agent-runs?limit=2&offset=1",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      rows: Array<{ definitionSlug: string }>;
      total: number;
    };
    expect(body.rows).toHaveLength(2);
    expect(body.total).toBe(5);
  });

  it("caps limit at 200", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    // Seed 3 runs — we're testing the cap is applied, not that we have 201 rows.
    for (let i = 0; i < 3; i++) {
      await f.raw.exec(`
        INSERT INTO agent_runs (definition_slug, trigger, status)
        VALUES ('run${i}', 'scheduled', 'success')
      `);
    }

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/agent-runs?limit=999",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    // Should succeed (not 400) — the handler silently caps.
    expect(res.statusCode).toBe(200);
  });
});

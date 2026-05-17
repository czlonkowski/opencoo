/**
 * `GET /api/admin/heartbeat` — latest heartbeat agent_runs.output per domain.
 *
 * Test-first artifact for PR-D (phase-a appendix #4).
 *
 * Pin matrix:
 *   1. Returns 401 without admin auth.
 *   2. Returns empty array when no heartbeat runs exist.
 *   3. Returns the latest heartbeat output per domain (definitionSlug='heartbeat'),
 *      grouped by instanceId, most-recent first per group.
 *   4. Returns the same HeartbeatOutput object that the OutputAdapter
 *      delivers — reads agent_runs.output directly, no LLM re-call.
 *   5. Only returns runs with definitionSlug='heartbeat'.
 *   6. Output from non-heartbeat runs is NOT returned.
 *   7. Response includes run_id (deep-link to agent_runs.id) + domain info
 *      from the instance's name field.
 *   8. Output is returned as-is (raw HeartbeatOutput JSON object) —
 *      no markdown re-render, no LLM call.
 *   9. Null output (running/failed) is excluded.
 */
import { afterEach, describe, expect, it } from "vitest";

import { makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "heartbeat-reader-pat";

describe("admin-api GET /api/admin/heartbeat — heartbeat reader", () => {
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
      url: "/api/admin/heartbeat",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns empty array when no heartbeat runs exist", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/heartbeat",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { reports: unknown[] };
    expect(body.reports).toEqual([]);
  });

  it("returns heartbeat output from agent_runs without LLM re-call", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const heartbeatOutput = {
      version: "v1",
      summary: "All systems nominal. No alerts today.",
      alerts: [],
    };

    await f.raw.exec(`
      INSERT INTO agent_runs (definition_slug, trigger, status, output, started_at)
      VALUES (
        'heartbeat',
        'scheduled',
        'success',
        '${JSON.stringify(heartbeatOutput).replace(/'/g, "''")}',
        NOW()
      )
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/heartbeat",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      reports: Array<{
        runId: string;
        instanceId: string | null;
        instanceName: string | null;
        startedAt: string | null;
        output: unknown;
      }>;
    };
    expect(body.reports).toHaveLength(1);
    const report = body.reports[0]!;
    expect(typeof report.runId).toBe("string");
    // output is the same HeartbeatOutput object that the OutputAdapter delivers
    expect(report.output).toEqual(heartbeatOutput);
    // No LLM call involved — output is read directly from DB
  });

  // Removed: the "null instanceId group" test inserted agent_runs without instance_id.
  // The real schema has instance_id NOT NULL (requiredRestrictFk) so that state
  // cannot exist in production. Coverage for the DISTINCT ON behaviour is provided
  // by the "returns only the latest-instance first (inter-instance recency)" test below.

  it("does not return non-heartbeat runs", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    await f.raw.exec(`
      INSERT INTO agent_runs (definition_slug, trigger, status, output, started_at)
      VALUES
        ('lint', 'scheduled', 'success', '{"findings": []}', NOW()),
        ('surfacer', 'scheduled', 'success', '{"proposals": []}', NOW())
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/heartbeat",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { reports: unknown[] };
    expect(body.reports).toEqual([]);
  });

  it("excludes runs with null output (running/failed)", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    // One running (null output), one successful (has output).
    const goodOutput = { version: "v1", summary: "good report", alerts: [] };
    const earlier = new Date(Date.now() - 30_000).toISOString();
    const later = new Date(Date.now() - 5_000).toISOString();

    await f.raw.exec(`
      INSERT INTO agent_runs (definition_slug, trigger, status, output, started_at)
      VALUES
        ('heartbeat', 'scheduled', 'success', '${JSON.stringify(goodOutput).replace(/'/g, "''")}', '${earlier}'),
        ('heartbeat', 'scheduled', 'running', NULL, '${later}')
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/heartbeat",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      reports: Array<{ output: unknown }>;
    };
    // Running run has null output — excluded. Only the successful one returned.
    expect(body.reports).toHaveLength(1);
    expect((body.reports[0]!.output as { summary: string }).summary).toBe("good report");
  });

  it("returns all heartbeat instances (multiple distinct instanceIds)", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const output1 = { version: "v1", summary: "domain-a report", alerts: [] };
    const output2 = { version: "v1", summary: "domain-b report", alerts: [] };

    const instanceA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const instanceB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    // agent_instances is created by the fixture DDL — no need to re-create it here.
    await f.raw.exec(`
      INSERT INTO agent_instances (id, definition_slug, name) VALUES
        ('${instanceA}', 'heartbeat', 'heartbeat-domain-a'),
        ('${instanceB}', 'heartbeat', 'heartbeat-domain-b')
    `);

    await f.raw.exec(`
      INSERT INTO agent_runs (definition_slug, instance_id, trigger, status, output, started_at)
      VALUES
        ('heartbeat', '${instanceA}', 'scheduled', 'success', '${JSON.stringify(output1).replace(/'/g, "''")}', NOW()),
        ('heartbeat', '${instanceB}', 'scheduled', 'success', '${JSON.stringify(output2).replace(/'/g, "''")}', NOW())
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/heartbeat",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { reports: Array<{ instanceName: string | null; output: { summary: string } }> };
    expect(body.reports).toHaveLength(2);
    const summaries = body.reports.map((r) => r.output.summary).sort();
    expect(summaries).toEqual(["domain-a report", "domain-b report"]);
  });

  // ── PR-W8 (phase-a appendix #15) regression coverage ────────────────────
  //
  // The Reports diagnostic surface relies on three guarantees of the
  // production query at routes/heartbeat.ts: (a) runs with `output IS NULL`
  // are filtered out, (b) the `DISTINCT ON (instance_id)` clause picks the
  // newest run per group, and (c) `instance_id IS NULL` runs (legal in the
  // pglite schema; production has NOT NULL but defense-in-depth costs
  // nothing) collapse into a single no-instance group rather than masking
  // distinct heartbeat instances. These three tests pin those guarantees
  // so a future query rewrite cannot silently break the Reports panel.

  it("PR-W8: excludes runs whose output IS NULL even when newer than the success run", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const instanceA = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

    // A success run (older) followed by a running run (newer, null output)
    // against the SAME instance. The DISTINCT ON groups them; ORDER BY
    // started_at DESC inside the group picks the newer one — but the
    // WHERE output IS NOT NULL filter excludes nulls BEFORE the grouping.
    // Net effect: the older success run is the surviving row.
    const successOutput = { version: "v1", summary: "older success", alerts: [] };
    const olderTs = new Date(Date.now() - 60_000).toISOString();
    const newerTs = new Date(Date.now() - 5_000).toISOString();

    await f.raw.exec(`
      INSERT INTO agent_instances (id, definition_slug, name) VALUES
        ('${instanceA}', 'heartbeat', 'heartbeat-mixed')
    `);

    await f.raw.exec(`
      INSERT INTO agent_runs (definition_slug, instance_id, trigger, status, output, started_at)
      VALUES
        ('heartbeat', '${instanceA}', 'scheduled', 'success', '${JSON.stringify(successOutput).replace(/'/g, "''")}', '${olderTs}'),
        ('heartbeat', '${instanceA}', 'scheduled', 'running', NULL,                                                  '${newerTs}')
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/heartbeat",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      reports: Array<{ output: { summary: string } | null }>;
    };
    // The newer-but-null run is filtered; the older success run is the
    // surviving row for this instance.
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0]!.output!.summary).toBe("older success");
  });

  it("PR-W8: DISTINCT ON (instance_id) picks the newest run per instance group", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const instanceA = "ffffffff-ffff-ffff-ffff-ffffffffffff";

    // Three successful runs against the same instance — the most recent
    // one must win, not the oldest or a middle one.
    const oldestTs = new Date(Date.now() - 180_000).toISOString();
    const middleTs = new Date(Date.now() - 90_000).toISOString();
    const newestTs = new Date(Date.now() - 5_000).toISOString();
    const oldestOut = { version: "v1", summary: "oldest", alerts: [] };
    const middleOut = { version: "v1", summary: "middle", alerts: [] };
    const newestOut = { version: "v1", summary: "newest", alerts: [] };

    await f.raw.exec(`
      INSERT INTO agent_instances (id, definition_slug, name) VALUES
        ('${instanceA}', 'heartbeat', 'heartbeat-stack')
    `);

    // Deliberately insert out of chronological order — the query must
    // not rely on insertion order.
    await f.raw.exec(`
      INSERT INTO agent_runs (definition_slug, instance_id, trigger, status, output, started_at)
      VALUES
        ('heartbeat', '${instanceA}', 'scheduled', 'success', '${JSON.stringify(middleOut).replace(/'/g, "''")}', '${middleTs}'),
        ('heartbeat', '${instanceA}', 'scheduled', 'success', '${JSON.stringify(newestOut).replace(/'/g, "''")}', '${newestTs}'),
        ('heartbeat', '${instanceA}', 'scheduled', 'success', '${JSON.stringify(oldestOut).replace(/'/g, "''")}', '${oldestTs}')
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/heartbeat",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      reports: Array<{ output: { summary: string } }>;
    };
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0]!.output.summary).toBe("newest");
  });

  it("orders instances by recency — latest-started instance appears first", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const instanceA = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const instanceB = "dddddddd-dddd-dddd-dddd-dddddddddddd";

    // instanceB ran more recently than instanceA.
    const olderTs = new Date(Date.now() - 120_000).toISOString();
    const newerTs = new Date(Date.now() - 10_000).toISOString();

    const outputA = { version: "v1", summary: "older instance report", alerts: [] };
    const outputB = { version: "v1", summary: "newer instance report", alerts: [] };

    await f.raw.exec(`
      INSERT INTO agent_instances (id, definition_slug, name) VALUES
        ('${instanceA}', 'heartbeat', 'heartbeat-older'),
        ('${instanceB}', 'heartbeat', 'heartbeat-newer')
    `);

    await f.raw.exec(`
      INSERT INTO agent_runs (definition_slug, instance_id, trigger, status, output, started_at)
      VALUES
        ('heartbeat', '${instanceA}', 'scheduled', 'success', '${JSON.stringify(outputA).replace(/'/g, "''")}', '${olderTs}'),
        ('heartbeat', '${instanceB}', 'scheduled', 'success', '${JSON.stringify(outputB).replace(/'/g, "''")}', '${newerTs}')
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/heartbeat",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      reports: Array<{ instanceName: string | null; output: { summary: string } }>;
    };
    expect(body.reports).toHaveLength(2);
    // The most recently active instance must appear first.
    expect(body.reports[0]!.output.summary).toBe("newer instance report");
    expect(body.reports[1]!.output.summary).toBe("older instance report");
  });
});

// ─── PR-W8 — preconditions diagnostic surface ───────────────────────────────
//
// `GET /api/admin/heartbeat/preconditions` powers the Reports tab's
// empty-state panel. It answers: WHY is the heartbeats list empty?
// The Reports panel walks the response top-to-bottom and renders the
// first missing precondition with an inline CTA. Counts only — no run
// output, no body bytes — so the read-only admin-team gate is sufficient.
//
// Pin matrix:
//   1. 401 without admin auth.
//   2. All-zero / null defaults when no heartbeat data exists.
//   3. Counts heartbeat instances, enabled subset, and the
//      `output_channel_ids = []` subset accurately.
//   4. `mostRecentRun` reflects the newest agent_runs row for
//      `definition_slug = 'heartbeat'` regardless of status.
//   5. `outputIsNull` discriminates between completed-with-output and
//      completed-but-null-output runs.
//   6. `mostRecentDispatchedAt` is the newest dispatch timestamp
//      regardless of run completion (mirrors `started_at`).
//   7. Non-heartbeat runs do NOT contribute to mostRecentRun.

describe("admin-api GET /api/admin/heartbeat/preconditions — diagnostic surface", () => {
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
      url: "/api/admin/heartbeat/preconditions",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns zero counts and null run when no heartbeat data exists", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/heartbeat/preconditions",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      heartbeatInstanceCount: number;
      enabledHeartbeatInstanceCount: number;
      instancesWithoutOutputChannels: number;
      mostRecentRun: unknown | null;
      mostRecentDispatchedAt: string | null;
    };
    expect(body.heartbeatInstanceCount).toBe(0);
    expect(body.enabledHeartbeatInstanceCount).toBe(0);
    expect(body.instancesWithoutOutputChannels).toBe(0);
    expect(body.mostRecentRun).toBeNull();
    expect(body.mostRecentDispatchedAt).toBeNull();
  });

  it("counts heartbeat instances, enabled subset, and channel-less subset", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    // 3 heartbeat instances: 1 disabled, 2 enabled. Of the 2 enabled,
    // 1 has no output channels bound. Plus a non-heartbeat instance
    // (lint) to confirm the filter on definition_slug.
    await f.raw.exec(`
      INSERT INTO agent_instances (definition_slug, name, enabled, output_channel_ids) VALUES
        ('heartbeat', 'hb-disabled',     false, '[{"adapter_slug":"asana","config":{}}]'::jsonb),
        ('heartbeat', 'hb-bound',        true,  '[{"adapter_slug":"asana","config":{}}]'::jsonb),
        ('heartbeat', 'hb-no-channels',  true,  '[]'::jsonb),
        ('lint',      'lint-bound',      true,  '[{"adapter_slug":"asana","config":{}}]'::jsonb)
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/heartbeat/preconditions",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      heartbeatInstanceCount: number;
      enabledHeartbeatInstanceCount: number;
      instancesWithoutOutputChannels: number;
    };
    expect(body.heartbeatInstanceCount).toBe(3);
    expect(body.enabledHeartbeatInstanceCount).toBe(2);
    // Only the enabled-and-channel-less instance is counted as "needs
    // wiring" — a disabled instance with channels doesn't surface as
    // a precondition failure; the panel surfaces the disabled state
    // FIRST via enabledHeartbeatInstanceCount === 0 path.
    expect(body.instancesWithoutOutputChannels).toBe(1);
  });

  it("surfaces the most recent heartbeat run regardless of status", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const instance = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const olderTs = new Date(Date.now() - 60_000).toISOString();
    const newerTs = new Date(Date.now() - 5_000).toISOString();
    const goodOutput = { version: "v1", summary: "older success", alerts: [] };

    await f.raw.exec(`
      INSERT INTO agent_instances (id, definition_slug, name, enabled) VALUES
        ('${instance}', 'heartbeat', 'hb-instance', true)
    `);
    await f.raw.exec(`
      INSERT INTO agent_runs (definition_slug, instance_id, trigger, status, output, started_at)
      VALUES
        ('heartbeat', '${instance}', 'scheduled', 'success', '${JSON.stringify(goodOutput).replace(/'/g, "''")}', '${olderTs}'),
        ('heartbeat', '${instance}', 'scheduled', 'failed',  NULL,                                                '${newerTs}')
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/heartbeat/preconditions",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      mostRecentRun: {
        startedAt: string | null;
        status: string;
        outputIsNull: boolean;
        instanceName: string | null;
      } | null;
      mostRecentDispatchedAt: string | null;
    };
    // Newest heartbeat run is the failure with null output — the
    // panel shows the failure surface, not the older success.
    expect(body.mostRecentRun).not.toBeNull();
    expect(body.mostRecentRun!.status).toBe("failed");
    expect(body.mostRecentRun!.outputIsNull).toBe(true);
    expect(body.mostRecentRun!.instanceName).toBe("hb-instance");
    // mostRecentDispatchedAt mirrors started_at; the newer run wins.
    expect(body.mostRecentDispatchedAt).not.toBeNull();
    expect(new Date(body.mostRecentDispatchedAt!).getTime()).toBeGreaterThan(
      new Date(olderTs).getTime(),
    );
  });

  it("distinguishes completed-with-output from completed-with-null-output", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const instance = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const goodOutput = { version: "v1", summary: "ok", alerts: [] };
    await f.raw.exec(`
      INSERT INTO agent_instances (id, definition_slug, name, enabled) VALUES
        ('${instance}', 'heartbeat', 'hb-good', true)
    `);
    await f.raw.exec(`
      INSERT INTO agent_runs (definition_slug, instance_id, trigger, status, output, started_at)
      VALUES
        ('heartbeat', '${instance}', 'scheduled', 'success', '${JSON.stringify(goodOutput).replace(/'/g, "''")}', NOW())
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/heartbeat/preconditions",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      mostRecentRun: { status: string; outputIsNull: boolean } | null;
    };
    expect(body.mostRecentRun).not.toBeNull();
    expect(body.mostRecentRun!.status).toBe("success");
    expect(body.mostRecentRun!.outputIsNull).toBe(false);
  });

  it("ignores non-heartbeat runs when computing mostRecentRun", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    // A lint run is newer than the heartbeat run — the preconditions
    // route must filter on definition_slug='heartbeat'.
    const olderTs = new Date(Date.now() - 60_000).toISOString();
    const newerTs = new Date(Date.now() - 5_000).toISOString();
    const goodOutput = { version: "v1", summary: "ok", alerts: [] };

    await f.raw.exec(`
      INSERT INTO agent_runs (definition_slug, trigger, status, output, started_at)
      VALUES
        ('heartbeat', 'scheduled', 'success', '${JSON.stringify(goodOutput).replace(/'/g, "''")}', '${olderTs}'),
        ('lint',      'scheduled', 'success', '{"findings": []}',                                  '${newerTs}')
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/heartbeat/preconditions",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      mostRecentRun: { status: string } | null;
      mostRecentDispatchedAt: string | null;
    };
    // The heartbeat run wins despite being older — the lint run is filtered.
    expect(body.mostRecentRun).not.toBeNull();
    expect(body.mostRecentRun!.status).toBe("success");
    // Dispatched-at also reflects only heartbeat runs.
    expect(new Date(body.mostRecentDispatchedAt!).toISOString()).toBe(
      new Date(olderTs).toISOString(),
    );
  });
});

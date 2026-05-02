/**
 * `GET /api/admin/pipelines` — per-queue stats.
 *
 * Test-first artifact for PR-B (phase-a appendix #4).
 *
 * Pin matrix:
 *   1. Requires admin auth — 401 without Bearer.
 *   2. Returns an array of queue stat objects (even when no queues wired).
 *   3. When a mock queue is injected, its stats appear in the response.
 *   4. Each queue stat carries: name, depth, failedCount, processedPerHour,
 *      lastRunAt, lastFailureAt, dlqCount.
 *   5. Non-fatal probe failure: if queue probe throws, the pipeline entry
 *      still appears with zeroed stats (no 500).
 */
import { afterEach, describe, expect, it } from "vitest";

import { makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "pipelines-list-pat";

/** Minimal queue mock that returns controllable stats. */
function makeQueueMock(overrides: {
  name?: string;
  waitingCount?: number;
  failedCount?: number;
  completedCount?: number;
  shouldThrow?: boolean;
}) {
  return {
    name: overrides.name ?? "ingestion.scanner",
    getJobCounts: async (...states: string[]) => {
      if (overrides.shouldThrow === true) {
        throw new Error("redis connection refused");
      }
      const result: Record<string, number> = {};
      for (const s of states) {
        if (s === "waiting") result["waiting"] = overrides.waitingCount ?? 0;
        if (s === "failed") result["failed"] = overrides.failedCount ?? 0;
        if (s === "completed") result["completed"] = overrides.completedCount ?? 0;
      }
      return result;
    },
  };
}

describe("admin-api GET /api/admin/pipelines — pipeline stats", () => {
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
      url: "/api/admin/pipelines",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns empty pipelines array when no queues are wired", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/pipelines",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { pipelines: unknown[] };
    expect(Array.isArray(body.pipelines)).toBe(true);
  });

  it("returns queue stats when a queue is wired", async () => {
    const queueMock = makeQueueMock({
      name: "ingestion.scanner",
      waitingCount: 3,
      failedCount: 1,
      completedCount: 42,
    });
    const f = await makeAdminFixture({ ingestionQueue: queueMock });
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/pipelines",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      pipelines: Array<{
        name: string;
        depth: number;
        failedCount: number;
        dlqCount: number;
      }>;
    };
    const pipe = body.pipelines.find((p) => p.name === "ingestion.scanner");
    expect(pipe).toBeDefined();
    expect(pipe!.depth).toBe(3);
    expect(pipe!.failedCount).toBe(1);
  });

  it("each pipeline stat carries required fields", async () => {
    const queueMock = makeQueueMock({ name: "ingestion.scanner" });
    const f = await makeAdminFixture({ ingestionQueue: queueMock });
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/pipelines",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    const body = JSON.parse(res.body) as {
      pipelines: Array<Record<string, unknown>>;
    };
    const pipe = body.pipelines[0]!;
    expect(typeof pipe["name"]).toBe("string");
    expect(typeof pipe["depth"]).toBe("number");
    expect(typeof pipe["failedCount"]).toBe("number");
    expect(typeof pipe["dlqCount"]).toBe("number");
    // lastRunAt and lastFailureAt may be null (no runs yet)
    expect("lastRunAt" in pipe).toBe(true);
    expect("lastFailureAt" in pipe).toBe(true);
  });

  it("returns zeroed stats (no 500) when the queue probe throws", async () => {
    const queueMock = makeQueueMock({
      name: "ingestion.scanner",
      shouldThrow: true,
    });
    const f = await makeAdminFixture({ ingestionQueue: queueMock });
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/pipelines",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    // Non-fatal: 200 with zeroed stats, not 500.
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      pipelines: Array<{ name: string; depth: number; failedCount: number }>;
    };
    const pipe = body.pipelines.find((p) => p.name === "ingestion.scanner");
    expect(pipe).toBeDefined();
    expect(pipe!.depth).toBe(0);
    expect(pipe!.failedCount).toBe(0);
  });
});

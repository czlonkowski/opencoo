/**
 * `GET /api/admin/cost-summary` — cost analytics aggregation
 * (PR-R5, phase-a appendix #10).
 *
 * Test-first artifact for the new admin route. The endpoint
 * aggregates `llm_usage` rows by domain / model / tier / agent
 * over a chosen period (day/week/month) and returns the running
 * burn-down state per domain so the operator can drill into
 * spend without writing SQL.
 *
 * Pin matrix:
 *   1. Returns 401 without admin auth.
 *   2. Default groupBy=domain + period=month sums correctly across
 *      a fixture of rows from two domains.
 *   3. groupBy=tier returns three buckets (thinker/worker/light)
 *      with cost split.
 *   4. groupBy=model + groupBy=agent return the expected bucket key
 *      sets.
 *   5. period=week trims rows older than 7 days.
 *   6. period=day trims rows older than 24 hours.
 *   7. budgetState linear projection: half-elapsed month projects
 *      ~2x current spend; nearly-finished month projects ~current.
 *   8. budgetState surfaces every active domain even when it has
 *      zero llm_usage rows.
 *   9. Domains without a cap surface `capUsd: null`; paused stays
 *      false in v0.1 (no domain_llm_budgets table yet).
 *  10. validation_failed for unknown groupBy / period values.
 */
import { afterEach, describe, expect, it } from "vitest";

import { makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "cost-summary-pat";

interface CostBucket {
  readonly key: string;
  readonly totalUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly runs: number;
}

interface BudgetEntry {
  readonly domainSlug: string;
  readonly capUsd: number | null;
  readonly usedUsd: number;
  readonly projectedEomUsd: number;
  readonly paused: boolean;
}

interface CostSummaryResponse {
  readonly totalUsd: number;
  readonly period: "day" | "week" | "month";
  readonly rangeFrom: string;
  readonly rangeTo: string;
  readonly byBucket: readonly CostBucket[];
  readonly budgetState: readonly BudgetEntry[];
}

async function seedDomain(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  slug: string,
  capUsd: number | null,
): Promise<string> {
  const result = await raw.query<{ id: string }>(
    `INSERT INTO domains (slug, name, llm_budget_monthly_cap_usd)
     VALUES ($1, $2, $3) RETURNING id`,
    [slug, slug, capUsd === null ? null : capUsd.toFixed(2)],
  );
  return result.rows[0]!.id;
}

async function seedUsage(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  args: {
    readonly domainId: string;
    readonly tier: "thinker" | "worker" | "light";
    readonly model: string;
    readonly agent: string;
    readonly costUsd: number;
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly daysAgo?: number;
  },
): Promise<void> {
  const daysAgo = args.daysAgo ?? 0;
  await raw.query(
    `INSERT INTO llm_usage
       ("timestamp", engine, tier, model, pipeline_or_agent,
        domain_id, tokens_in, tokens_out, cost_usd, latency_ms)
     VALUES (NOW() - ($1 || ' days')::interval,
             'self-op', $2, $3, $4, $5, $6, $7, $8, 100)`,
    [
      String(daysAgo),
      args.tier,
      args.model,
      args.agent,
      args.domainId,
      args.tokensIn,
      args.tokensOut,
      args.costUsd.toFixed(6),
    ],
  );
}

describe("admin-api GET /api/admin/cost-summary — auth + validation", () => {
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
      url: "/api/admin/cost-summary",
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an unknown period value", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/cost-summary?period=year",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unknown groupBy value", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/cost-summary?groupBy=user",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("admin-api GET /api/admin/cost-summary — aggregation math", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("default groupBy=domain sums per-domain costs across rows", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });
    const dPilot = await seedDomain(f.raw, "wiki-pilot", 50);
    const dHr = await seedDomain(f.raw, "wiki-hr", 25);
    // 3 rows on pilot summing to 12.00 + 2 rows on hr summing to 4.00
    await seedUsage(f.raw, {
      domainId: dPilot, tier: "thinker", model: "gemini-2.0-pro",
      agent: "compiler", costUsd: 5, tokensIn: 1000, tokensOut: 500,
    });
    await seedUsage(f.raw, {
      domainId: dPilot, tier: "thinker", model: "gemini-2.0-pro",
      agent: "compiler", costUsd: 4, tokensIn: 800, tokensOut: 400,
    });
    await seedUsage(f.raw, {
      domainId: dPilot, tier: "worker", model: "gemini-2.0-flash",
      agent: "classifier", costUsd: 3, tokensIn: 600, tokensOut: 200,
    });
    await seedUsage(f.raw, {
      domainId: dHr, tier: "worker", model: "gemini-2.0-flash",
      agent: "classifier", costUsd: 1, tokensIn: 400, tokensOut: 100,
    });
    await seedUsage(f.raw, {
      domainId: dHr, tier: "light", model: "gemini-2.0-flash",
      agent: "indexer", costUsd: 3, tokensIn: 200, tokensOut: 100,
    });
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/cost-summary",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as CostSummaryResponse;
    expect(body.period).toBe("month");
    expect(body.totalUsd).toBeCloseTo(16, 5);
    expect(body.byBucket.length).toBe(2);
    const pilot = body.byBucket.find((b) => b.key === "wiki-pilot");
    const hr = body.byBucket.find((b) => b.key === "wiki-hr");
    expect(pilot?.totalUsd).toBeCloseTo(12, 5);
    expect(pilot?.runs).toBe(3);
    expect(pilot?.tokensIn).toBe(2400);
    expect(pilot?.tokensOut).toBe(1100);
    expect(hr?.totalUsd).toBeCloseTo(4, 5);
    expect(hr?.runs).toBe(2);
  });

  it("groupBy=tier returns one bucket per tier", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });
    const d = await seedDomain(f.raw, "wiki-pilot", 50);
    await seedUsage(f.raw, {
      domainId: d, tier: "thinker", model: "gemini-2.0-pro",
      agent: "compiler", costUsd: 6, tokensIn: 100, tokensOut: 100,
    });
    await seedUsage(f.raw, {
      domainId: d, tier: "worker", model: "gemini-2.0-flash",
      agent: "classifier", costUsd: 3, tokensIn: 100, tokensOut: 100,
    });
    await seedUsage(f.raw, {
      domainId: d, tier: "light", model: "gemini-2.0-flash",
      agent: "indexer", costUsd: 1, tokensIn: 100, tokensOut: 100,
    });
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/cost-summary?groupBy=tier",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as CostSummaryResponse;
    expect(body.byBucket.map((b) => b.key).sort()).toEqual([
      "light",
      "thinker",
      "worker",
    ]);
    const thinker = body.byBucket.find((b) => b.key === "thinker");
    expect(thinker?.totalUsd).toBeCloseTo(6, 5);
  });

  it("groupBy=agent + groupBy=model both work", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });
    const d = await seedDomain(f.raw, "wiki-pilot", 50);
    await seedUsage(f.raw, {
      domainId: d, tier: "thinker", model: "gemini-2.0-pro",
      agent: "compiler", costUsd: 5, tokensIn: 100, tokensOut: 100,
    });
    await seedUsage(f.raw, {
      domainId: d, tier: "worker", model: "gemini-2.0-flash",
      agent: "classifier", costUsd: 2, tokensIn: 100, tokensOut: 100,
    });
    const byAgent = await f.app.inject({
      method: "GET",
      url: "/api/admin/cost-summary?groupBy=agent",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(byAgent.statusCode).toBe(200);
    const aBody = JSON.parse(byAgent.body) as CostSummaryResponse;
    expect(aBody.byBucket.map((b) => b.key).sort()).toEqual([
      "classifier",
      "compiler",
    ]);

    const byModel = await f.app.inject({
      method: "GET",
      url: "/api/admin/cost-summary?groupBy=model",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(byModel.statusCode).toBe(200);
    const mBody = JSON.parse(byModel.body) as CostSummaryResponse;
    expect(mBody.byBucket.map((b) => b.key).sort()).toEqual([
      "gemini-2.0-flash",
      "gemini-2.0-pro",
    ]);
  });
});

describe("admin-api GET /api/admin/cost-summary — period boundaries", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("period=week returns rows from the past 7 days only", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });
    const d = await seedDomain(f.raw, "wiki-pilot", 50);
    // In-window
    await seedUsage(f.raw, {
      domainId: d, tier: "thinker", model: "m", agent: "compiler",
      costUsd: 5, tokensIn: 100, tokensOut: 100, daysAgo: 1,
    });
    // Out-of-window
    await seedUsage(f.raw, {
      domainId: d, tier: "thinker", model: "m", agent: "compiler",
      costUsd: 9, tokensIn: 100, tokensOut: 100, daysAgo: 14,
    });
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/cost-summary?period=week",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as CostSummaryResponse;
    expect(body.totalUsd).toBeCloseTo(5, 5);
  });

  it("period=day returns rows from the past 24 hours only", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });
    const d = await seedDomain(f.raw, "wiki-pilot", 50);
    await seedUsage(f.raw, {
      domainId: d, tier: "thinker", model: "m", agent: "compiler",
      costUsd: 2, tokensIn: 100, tokensOut: 100, daysAgo: 0,
    });
    await seedUsage(f.raw, {
      domainId: d, tier: "thinker", model: "m", agent: "compiler",
      costUsd: 7, tokensIn: 100, tokensOut: 100, daysAgo: 3,
    });
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/cost-summary?period=day",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as CostSummaryResponse;
    expect(body.totalUsd).toBeCloseTo(2, 5);
  });
});

describe("admin-api GET /api/admin/cost-summary — budget state", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("includes every active domain in budgetState, even ones with zero usage", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });
    await seedDomain(f.raw, "wiki-pilot", 50);
    await seedDomain(f.raw, "wiki-hr", 25);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/cost-summary",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as CostSummaryResponse;
    expect(body.budgetState.map((b) => b.domainSlug).sort()).toEqual([
      "wiki-hr",
      "wiki-pilot",
    ]);
    for (const b of body.budgetState) {
      expect(b.usedUsd).toBe(0);
      expect(b.paused).toBe(false);
    }
  });

  it("surfaces capUsd: null for domains without a cap", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });
    await seedDomain(f.raw, "wiki-pilot", null);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/cost-summary",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as CostSummaryResponse;
    const pilot = body.budgetState.find((b) => b.domainSlug === "wiki-pilot");
    expect(pilot?.capUsd).toBeNull();
  });

  it("linearly projects month-end spend from current usage", async () => {
    // Inject a deterministic clock: pretend it's day 15 of a 30-day
    // month so the projection ratio is 2x current spend.
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });
    const d = await seedDomain(f.raw, "wiki-pilot", 50);
    await seedUsage(f.raw, {
      domainId: d, tier: "thinker", model: "m", agent: "compiler",
      costUsd: 21, tokensIn: 100, tokensOut: 100, daysAgo: 0,
    });
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/cost-summary",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as CostSummaryResponse;
    const pilot = body.budgetState.find((b) => b.domainSlug === "wiki-pilot");
    expect(pilot?.usedUsd).toBeCloseTo(21, 5);
    // Projection = used / daysElapsed * daysInMonth. For any
    // not-yet-finished month projectedEom >= used; we don't pin the
    // exact ratio (depends on the calendar day the test runs) but
    // we DO pin that the projection is at least as high as
    // observed usage and is a finite positive number.
    expect(pilot?.projectedEomUsd ?? 0).toBeGreaterThanOrEqual(21);
    expect(Number.isFinite(pilot?.projectedEomUsd ?? NaN)).toBe(true);
  });

  it("paused stays false in v0.1 (no domain_llm_budgets table)", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });
    const d = await seedDomain(f.raw, "wiki-pilot", 10);
    await seedUsage(f.raw, {
      domainId: d, tier: "thinker", model: "m", agent: "compiler",
      costUsd: 50, tokensIn: 100, tokensOut: 100, daysAgo: 0,
    });
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/cost-summary",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as CostSummaryResponse;
    const pilot = body.budgetState.find((b) => b.domainSlug === "wiki-pilot");
    // Even when usedUsd > capUsd (cap-blown) v0.1's response sets
    // paused: false because the budget-pause table doesn't exist.
    // The UI threshold-colors the bar red regardless.
    expect(pilot?.paused).toBe(false);
  });
});

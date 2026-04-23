import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";

import * as schema from "../src/db/schema/index.js";
import {
  FALLBACK_PRICING,
  PRICING,
  computeMonthToDateCost,
  costFor,
} from "../src/cost-tracker/index.js";
import type { DomainId } from "../src/db/brands.js";
import { ConsoleLogger, type LoggerWriteStream } from "../src/logger.js";

type Db = PgliteDatabase<typeof schema>;

interface CapturedStream extends LoggerWriteStream {
  readonly writes: string[];
}

function captureStream(): CapturedStream {
  const writes: string[] = [];
  return {
    writes,
    write(chunk: string): boolean {
      writes.push(chunk);
      return true;
    },
  };
}

async function freshDb(): Promise<Db> {
  const pg = new PGlite();
  // pg.exec (not pg.query) accepts multi-statement DDL in one call.
  await pg.exec(`
    CREATE TABLE domains (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      slug text NOT NULL,
      name text NOT NULL,
      class text NOT NULL DEFAULT 'knowledge',
      locale text NOT NULL DEFAULT 'en',
      governance_cadence text NOT NULL DEFAULT 'continuous',
      review_role text,
      llm_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
      llm_budget_monthly_cap_usd numeric(10, 2),
      retention_days integer,
      worldview_enabled boolean NOT NULL DEFAULT true,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    );
    CREATE TABLE llm_usage (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "timestamp" timestamp with time zone NOT NULL DEFAULT now(),
      engine text NOT NULL,
      tier text NOT NULL,
      model text NOT NULL,
      pipeline_or_agent text NOT NULL,
      document_id text,
      run_id uuid,
      domain_id uuid,
      tokens_in integer NOT NULL,
      tokens_out integer NOT NULL,
      cost_usd numeric(10, 6) NOT NULL,
      latency_ms integer NOT NULL,
      prompt_version text,
      created_at timestamp with time zone NOT NULL DEFAULT now()
    );
  `);
  return drizzle(pg, { schema });
}

describe("costFor — known models", () => {
  it("uses the pricing entry for a known model", () => {
    expect(PRICING).toHaveProperty("gpt-4o-mini");
    const cost = costFor("gpt-4o-mini", 1000, 500);
    expect(cost).toBeGreaterThan(0);
    const more = costFor("gpt-4o-mini", 10000, 5000);
    expect(more).toBeGreaterThan(cost);
  });

  it("is exact per-token — 1 input token costs exactly the input rate", () => {
    const entry = PRICING["gpt-4o-mini"];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(costFor("gpt-4o-mini", 1, 0)).toBeCloseTo(entry.inputPerToken, 12);
    expect(costFor("gpt-4o-mini", 0, 1)).toBeCloseTo(entry.outputPerToken, 12);
  });

  it("returns 0 for zero tokens", () => {
    expect(costFor("gpt-4o-mini", 0, 0)).toBe(0);
  });
});

describe("costFor — unknown model fallback", () => {
  it("returns FALLBACK_PRICING-derived cost for an unknown model", () => {
    const cost = costFor("unknown-provider/unknown-model", 1000, 500);
    const expected =
      1000 * FALLBACK_PRICING.inputPerToken +
      500 * FALLBACK_PRICING.outputPerToken;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it("warns via the injected logger when a fallback is used", () => {
    const stream = captureStream();
    const logger = new ConsoleLogger({ level: "debug", stream });
    costFor("unknown-provider/unknown-model", 100, 50, { logger });
    const parsed = stream.writes.map(
      (l) => JSON.parse(l) as { msg: string; model?: string },
    );
    const warnings = parsed.filter((e) =>
      e.msg.includes("cost-tracker.unknown_model"),
    );
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]?.model).toBe("unknown-provider/unknown-model");
  });

  it("accepts a missing logger (no-op)", () => {
    expect(() =>
      costFor("unknown-provider/unknown-model", 100, 50),
    ).not.toThrow();
  });
});

describe("computeMonthToDateCost", () => {
  let db: Db;
  const domainA = "11111111-1111-1111-1111-111111111111" as DomainId;
  const domainB = "22222222-2222-2222-2222-222222222222" as DomainId;

  beforeEach(async () => {
    db = await freshDb();
    await db.execute(sql`
      INSERT INTO domains (id, slug, name) VALUES (${domainA}, 'wiki-a', 'Wiki A')
    `);
    await db.execute(sql`
      INSERT INTO domains (id, slug, name) VALUES (${domainB}, 'wiki-b', 'Wiki B')
    `);
  });

  async function insertUsage(
    domainId: DomainId | null,
    costUsd: string,
    when: Date,
  ): Promise<void> {
    await db.execute(sql`
      INSERT INTO llm_usage (timestamp, engine, tier, model, pipeline_or_agent, domain_id, tokens_in, tokens_out, cost_usd, latency_ms)
      VALUES (${when.toISOString()}::timestamptz, 'ingestion', 'worker', 'gpt-4o-mini', 'test', ${domainId}, 100, 50, ${costUsd}, 42)
    `);
  }

  it("returns 0 when the domain has no rows this month", async () => {
    const total = await computeMonthToDateCost(db, domainA);
    expect(total).toBe(0);
  });

  it("sums current-month rows for the given domain", async () => {
    const now = new Date();
    await insertUsage(domainA, "1.50", now);
    await insertUsage(domainA, "0.25", now);
    const total = await computeMonthToDateCost(db, domainA);
    expect(total).toBeCloseTo(1.75, 6);
  });

  it("excludes rows from other domains", async () => {
    const now = new Date();
    await insertUsage(domainA, "1.00", now);
    await insertUsage(domainB, "99.00", now);
    const total = await computeMonthToDateCost(db, domainA);
    expect(total).toBeCloseTo(1.0, 6);
  });

  it("excludes rows from prior months", async () => {
    const now = new Date();
    const priorMonth = new Date(now);
    priorMonth.setDate(1);
    priorMonth.setHours(0, 0, 0, 0);
    priorMonth.setTime(priorMonth.getTime() - 24 * 60 * 60 * 1000);
    await insertUsage(domainA, "50.00", priorMonth);
    await insertUsage(domainA, "2.00", now);
    const total = await computeMonthToDateCost(db, domainA);
    expect(total).toBeCloseTo(2.0, 6);
  });

  it("excludes rows with NULL domain_id (not counted toward any cap)", async () => {
    const now = new Date();
    await insertUsage(null, "7.00", now);
    const total = await computeMonthToDateCost(db, domainA);
    expect(total).toBe(0);
  });
});

describe("PRICING constant contents", () => {
  it("covers the known default models from PR 08", () => {
    expect(PRICING).toHaveProperty("gpt-4o-mini");
    expect(PRICING).toHaveProperty("gpt-4o");
    expect(PRICING).toHaveProperty("claude-3-5-sonnet-latest");
    expect(PRICING).toHaveProperty("claude-3-5-haiku-latest");
    expect(PRICING).toHaveProperty("gemini-2.0-flash");
  });

  it("has inputPerToken + outputPerToken on every entry", () => {
    for (const [model, entry] of Object.entries(PRICING)) {
      expect(entry.inputPerToken, `${model}.inputPerToken`).toBeGreaterThan(0);
      expect(entry.outputPerToken, `${model}.outputPerToken`).toBeGreaterThan(
        0,
      );
    }
  });
});

describe("FALLBACK_PRICING", () => {
  it("is a positive-per-token pricing entry", () => {
    expect(FALLBACK_PRICING.inputPerToken).toBeGreaterThan(0);
    expect(FALLBACK_PRICING.outputPerToken).toBeGreaterThan(0);
  });

  it("is higher than the cheapest PRICING entry (err on the side of overestimate)", () => {
    const minInput = Math.min(
      ...Object.values(PRICING).map((e) => e.inputPerToken),
    );
    expect(FALLBACK_PRICING.inputPerToken).toBeGreaterThanOrEqual(minInput);
  });
});

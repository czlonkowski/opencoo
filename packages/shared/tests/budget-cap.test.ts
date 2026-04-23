import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";

import * as schema from "../src/db/schema/index.js";
import type { DomainId } from "../src/db/brands.js";
import {
  InMemoryQueuePauser,
  LlmBudgetExceededError,
  LlmRouter,
  MockLlmClient,
} from "../src/llm-router/index.js";
import { ConsoleLogger, type LoggerWriteStream } from "../src/logger.js";

type Db = PgliteDatabase<typeof schema>;

const domainId = "11111111-1111-1111-1111-111111111111" as DomainId;

function nullLogger(): ConsoleLogger {
  const stream: LoggerWriteStream = {
    write(): boolean {
      return true;
    },
  };
  return new ConsoleLogger({ stream });
}

async function freshDb(capUsd: string | null): Promise<Db> {
  const pg = new PGlite();
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
    CREATE TABLE llm_usage_debug (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      usage_id uuid NOT NULL REFERENCES llm_usage(id) ON DELETE CASCADE,
      prompt_text text NOT NULL,
      response_text text NOT NULL,
      created_at timestamp with time zone NOT NULL DEFAULT now()
    );
  `);
  const db = drizzle(pg, { schema });
  await db.execute(sql`
    INSERT INTO domains (id, slug, name, llm_policy, llm_budget_monthly_cap_usd)
    VALUES (${domainId}, 'wiki-x', 'Wiki X', ${JSON.stringify({
      thinker: { provider: "openai", model: "gpt-4o" },
      worker: { provider: "openai", model: "gpt-4o-mini" },
      light: { provider: "openai", model: "gpt-4o-mini" },
    })}::jsonb, ${capUsd})
  `);
  return db;
}

function newRouter(
  db: Db,
  mock: MockLlmClient,
): { router: LlmRouter; pauser: InMemoryQueuePauser } {
  const pauser = new InMemoryQueuePauser();
  const router = new LlmRouter({
    db,
    env: {},
    logger: nullLogger(),
    pauser,
    provider: mock,
  });
  return { router, pauser };
}

describe("LlmRouter budget cap", () => {
  let db: Db;

  it("is a no-op when domain.llm_budget_monthly_cap_usd is NULL (unlimited)", async () => {
    db = await freshDb(null);
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "x" },
      response: { text: "ok", tokensIn: 100000, tokensOut: 100000 },
    });
    const { router, pauser } = newRouter(db, mock);
    await expect(
      router.generateText({
        domainId,
        tier: "worker",
        pipelineOrAgent: "p",
        prompt: "x",
      }),
    ).resolves.toBeDefined();
    expect(pauser.pausedDomainIds.size).toBe(0);
  });

  it("permits a call whose MTD + estimate stays under cap", async () => {
    db = await freshDb("100.00");
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "small" },
      response: { text: "ok", tokensIn: 10, tokensOut: 5 },
    });
    const { router, pauser } = newRouter(db, mock);
    await expect(
      router.generateText({
        domainId,
        tier: "worker",
        pipelineOrAgent: "p",
        prompt: "small",
      }),
    ).resolves.toBeDefined();
    expect(pauser.pausedDomainIds.size).toBe(0);
  });

  it("throws LlmBudgetExceededError + pauses queues when MTD + estimate exceeds cap", async () => {
    db = await freshDb("0.01");
    // Seed $0.009 MTD so an estimate of ~$0.008 puts the sum at
    // ~$0.017 which is > $0.01. Each call costs tiny amounts per
    // gpt-4o-mini pricing; we're easily past the cap.
    await db.execute(sql`
      INSERT INTO llm_usage (timestamp, engine, tier, model, pipeline_or_agent, domain_id, tokens_in, tokens_out, cost_usd, latency_ms)
      VALUES (now(), 'ingestion', 'worker', 'gpt-4o-mini', 'prior', ${domainId}, 100, 100, ${"0.00995"}, 10)
    `);
    const mock = new MockLlmClient();
    const { router, pauser } = newRouter(db, mock);
    await expect(
      router.generateText({
        domainId,
        tier: "worker",
        pipelineOrAgent: "breaching",
        prompt: "a prompt long enough to push the estimate over the cap " +
          "a prompt long enough to push the estimate over the cap ".repeat(40),
      }),
    ).rejects.toThrow(LlmBudgetExceededError);
    expect(pauser.pausedDomainIds.has(domainId)).toBe(true);
  });

  it("inserts a synthetic 'budget-cap-breach' marker row on breach", async () => {
    db = await freshDb("0.01");
    await db.execute(sql`
      INSERT INTO llm_usage (timestamp, engine, tier, model, pipeline_or_agent, domain_id, tokens_in, tokens_out, cost_usd, latency_ms)
      VALUES (now(), 'ingestion', 'worker', 'gpt-4o-mini', 'prior', ${domainId}, 100, 100, ${"0.00995"}, 10)
    `);
    const mock = new MockLlmClient();
    const { router } = newRouter(db, mock);
    await router
      .generateText({
        domainId,
        tier: "worker",
        pipelineOrAgent: "breaching",
        prompt: "a prompt long enough to push the estimate over the cap " +
          "a prompt long enough to push the estimate over the cap ".repeat(40),
      })
      .catch(() => undefined);
    const rows = await db.execute<{ pipeline_or_agent: string }>(
      sql`SELECT pipeline_or_agent FROM llm_usage WHERE pipeline_or_agent = 'budget-cap-breach'`,
    );
    const list = Array.isArray(rows) ? rows : rows.rows;
    expect(list).toHaveLength(1);
  });

  it("is idempotent — two breaches leave the pauser with one entry", async () => {
    db = await freshDb("0.01");
    await db.execute(sql`
      INSERT INTO llm_usage (timestamp, engine, tier, model, pipeline_or_agent, domain_id, tokens_in, tokens_out, cost_usd, latency_ms)
      VALUES (now(), 'ingestion', 'worker', 'gpt-4o-mini', 'prior', ${domainId}, 100, 100, ${"0.00995"}, 10)
    `);
    const mock = new MockLlmClient();
    const { router, pauser } = newRouter(db, mock);
    const longPrompt =
      "a prompt long enough to push the estimate over the cap " +
      "a prompt long enough to push the estimate over the cap ".repeat(40);
    for (let i = 0; i < 2; i++) {
      await router
        .generateText({
          domainId,
          tier: "worker",
          pipelineOrAgent: "breaching",
          prompt: longPrompt,
        })
        .catch(() => undefined);
    }
    expect(pauser.pausedDomainIds.size).toBe(1);
  });

  it("does NOT call the provider when the budget blocks the call", async () => {
    db = await freshDb("0.01");
    await db.execute(sql`
      INSERT INTO llm_usage (timestamp, engine, tier, model, pipeline_or_agent, domain_id, tokens_in, tokens_out, cost_usd, latency_ms)
      VALUES (now(), 'ingestion', 'worker', 'gpt-4o-mini', 'prior', ${domainId}, 100, 100, ${"0.00995"}, 10)
    `);
    const mock = new MockLlmClient();
    let called = false;
    class Tracking extends MockLlmClient {
      override async generate(
        call: import("../src/llm-router/index.js").LlmProviderCall,
      ): Promise<import("../src/llm-router/index.js").LlmProviderResponse> {
        called = true;
        return super.generate(call);
      }
    }
    const tracking = new Tracking();
    tracking.register({
      match: { model: "gpt-4o-mini", promptIncludes: "" },
      response: { text: "SHOULD NOT RETURN", tokensIn: 1, tokensOut: 1 },
    });
    const { router } = newRouter(db, tracking);
    await expect(
      router.generateText({
        domainId,
        tier: "worker",
        pipelineOrAgent: "breaching",
        prompt:
          "a prompt long enough to push the estimate over the cap " +
          "a prompt long enough to push the estimate over the cap ".repeat(40),
      }),
    ).rejects.toThrow(LlmBudgetExceededError);
    expect(called).toBe(false);
    // Silence unused variable for `mock`.
    expect(mock).toBeDefined();
  });

  it("throws LlmBudgetExceededError with errorClass 'upstream-quota' (exponential backoff)", async () => {
    db = await freshDb("0.01");
    await db.execute(sql`
      INSERT INTO llm_usage (timestamp, engine, tier, model, pipeline_or_agent, domain_id, tokens_in, tokens_out, cost_usd, latency_ms)
      VALUES (now(), 'ingestion', 'worker', 'gpt-4o-mini', 'prior', ${domainId}, 100, 100, ${"0.00995"}, 10)
    `);
    const mock = new MockLlmClient();
    const { router } = newRouter(db, mock);
    try {
      await router.generateText({
        domainId,
        tier: "worker",
        pipelineOrAgent: "breaching",
        prompt:
          "a prompt long enough to push the estimate over the cap " +
          "a prompt long enough to push the estimate over the cap ".repeat(40),
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LlmBudgetExceededError);
      expect((err as LlmBudgetExceededError).errorClass).toBe(
        "upstream-quota",
      );
    }
  });
});

beforeEach(() => undefined);

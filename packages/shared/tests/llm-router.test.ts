import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { z } from "zod";

import * as schema from "../src/db/schema/index.js";
import type { DomainId } from "../src/db/brands.js";
import {
  InMemoryQueuePauser,
  LlmPolicyViolationError,
  LlmProviderError,
  LlmRouter,
  MockLlmClient,
} from "../src/llm-router/index.js";
import { ConsoleLogger, type LoggerWriteStream } from "../src/logger.js";

type Db = PgliteDatabase<typeof schema>;

function nullLogger(): ConsoleLogger {
  const nullStream: LoggerWriteStream = {
    write(): boolean {
      return true;
    },
  };
  return new ConsoleLogger({ stream: nullStream });
}

async function freshDb(): Promise<Db> {
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
  return drizzle(pg, { schema });
}

const domainId = "11111111-1111-1111-1111-111111111111" as DomainId;

interface SeededOpts {
  llmPolicy?: object;
  capUsd?: string | null;
}

async function seedDomain(db: Db, opts: SeededOpts = {}): Promise<void> {
  const policy = JSON.stringify(opts.llmPolicy ?? {});
  const cap = opts.capUsd ?? null;
  await db.execute(sql`
    INSERT INTO domains (id, slug, name, llm_policy, llm_budget_monthly_cap_usd)
    VALUES (${domainId}, 'wiki-x', 'Wiki X', ${policy}::jsonb, ${cap})
  `);
}

function newRouter(
  db: Db,
  mock: MockLlmClient,
  env: NodeJS.ProcessEnv = {},
): { router: LlmRouter; pauser: InMemoryQueuePauser } {
  const pauser = new InMemoryQueuePauser();
  const router = new LlmRouter({
    db,
    env,
    logger: nullLogger(),
    pauser,
    provider: mock,
  });
  return { router, pauser };
}

describe("LlmRouter — generateText basic flow", () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });

  it("routes via the configured policy tier model and records llm_usage", async () => {
    await seedDomain(db, {
      llmPolicy: {
        thinker: { provider: "openai", model: "gpt-4o" },
        worker: { provider: "openai", model: "gpt-4o-mini" },
        light: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "hello" },
      response: { text: "hi there", tokensIn: 10, tokensOut: 5 },
    });

    const { router } = newRouter(db, mock);
    const result = await router.generateText({
      domainId,
      tier: "worker",
      pipelineOrAgent: "ingest.classifier",
      prompt: "hello world",
    });

    expect(result.text).toBe("hi there");
    const rows = await db.execute<{
      model: string;
      tokens_in: number;
      tokens_out: number;
      cost_usd: string;
      domain_id: string;
      pipeline_or_agent: string;
    }>(sql`SELECT model, tokens_in, tokens_out, cost_usd, domain_id, pipeline_or_agent FROM llm_usage`);
    const list = Array.isArray(rows) ? rows : rows.rows;
    expect(list).toHaveLength(1);
    expect(list[0]?.model).toBe("gpt-4o-mini");
    expect(list[0]?.tokens_in).toBe(10);
    expect(list[0]?.tokens_out).toBe(5);
    expect(list[0]?.domain_id).toBe(domainId);
    expect(list[0]?.pipeline_or_agent).toBe("ingest.classifier");
  });

  it("falls back to FALLBACK_POLICY when domain.llm_policy is {}", async () => {
    await seedDomain(db, { llmPolicy: {} });
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "hello" },
      response: { text: "ok", tokensIn: 5, tokensOut: 2 },
    });
    const { router } = newRouter(db, mock);
    const result = await router.generateText({
      domainId,
      tier: "worker",
      pipelineOrAgent: "test",
      prompt: "hello",
    });
    expect(result.text).toBe("ok");
  });

  it("throws LlmPolicyViolationError when llm_policy cannot be parsed", async () => {
    await seedDomain(db, {
      llmPolicy: { thinker: "not-an-object" },
    });
    const mock = new MockLlmClient();
    const { router } = newRouter(db, mock);
    await expect(
      router.generateText({
        domainId,
        tier: "thinker",
        pipelineOrAgent: "x",
        prompt: "y",
      }),
    ).rejects.toThrow(LlmPolicyViolationError);
  });

  it("throws LlmPolicyViolationError on local_only:true with a cloud provider", async () => {
    await seedDomain(db, {
      llmPolicy: {
        thinker: { provider: "openai", model: "gpt-4o" },
        worker: { provider: "openai", model: "gpt-4o-mini" },
        light: { provider: "openai", model: "gpt-4o-mini" },
        local_only: true,
      },
    });
    const mock = new MockLlmClient();
    const { router } = newRouter(db, mock);
    await expect(
      router.generateText({
        domainId,
        tier: "worker",
        pipelineOrAgent: "x",
        prompt: "y",
      }),
    ).rejects.toThrow(LlmPolicyViolationError);
  });

  it("allows local_only:true with ollama provider", async () => {
    await seedDomain(db, {
      llmPolicy: {
        thinker: { provider: "ollama", model: "llama3.1" },
        worker: { provider: "ollama", model: "llama3.1" },
        light: { provider: "ollama", model: "llama3.1" },
        local_only: true,
      },
    });
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "llama3.1", promptIncludes: "y" },
      response: { text: "local answer", tokensIn: 3, tokensOut: 3 },
    });
    const { router } = newRouter(db, mock);
    const result = await router.generateText({
      domainId,
      tier: "worker",
      pipelineOrAgent: "x",
      prompt: "y",
    });
    expect(result.text).toBe("local answer");
  });
});

describe("LlmRouter — llm_usage is written on provider error (finally)", () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await seedDomain(db, {
      llmPolicy: {
        thinker: { provider: "openai", model: "gpt-4o" },
        worker: { provider: "openai", model: "gpt-4o-mini" },
        light: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
  });

  it("records llm_usage even when the provider throws", async () => {
    const mock = new MockLlmClient();
    const { router } = newRouter(db, mock);
    await expect(
      router.generateText({
        domainId,
        tier: "worker",
        pipelineOrAgent: "ingest.classifier",
        prompt: "unmatched prompt",
      }),
    ).rejects.toThrow(LlmProviderError);
    const rows = await db.execute<{ pipeline_or_agent: string }>(
      sql`SELECT pipeline_or_agent FROM llm_usage`,
    );
    const list = Array.isArray(rows) ? rows : rows.rows;
    expect(list).toHaveLength(1);
    expect(list[0]?.pipeline_or_agent).toBe("ingest.classifier");
  });
});

describe("LlmRouter — LLM_DEBUG_LOG gated debug insertion", () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await seedDomain(db, {
      llmPolicy: {
        thinker: { provider: "openai", model: "gpt-4o" },
        worker: { provider: "openai", model: "gpt-4o-mini" },
        light: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
  });

  it("writes llm_usage_debug alongside llm_usage when LLM_DEBUG_LOG=1", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "secret" },
      response: { text: "answer", tokensIn: 1, tokensOut: 1 },
    });
    const { router } = newRouter(db, mock, { LLM_DEBUG_LOG: "1" });
    await router.generateText({
      domainId,
      tier: "worker",
      pipelineOrAgent: "x",
      prompt: "the secret is 42",
    });
    const debug = await db.execute<{
      prompt_text: string;
      response_text: string;
    }>(sql`SELECT prompt_text, response_text FROM llm_usage_debug`);
    const list = Array.isArray(debug) ? debug : debug.rows;
    expect(list).toHaveLength(1);
    expect(list[0]?.prompt_text).toBe("the secret is 42");
    expect(list[0]?.response_text).toBe("answer");
  });

  it("does NOT write llm_usage_debug when LLM_DEBUG_LOG is unset", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "hi" },
      response: { text: "ok", tokensIn: 1, tokensOut: 1 },
    });
    const { router } = newRouter(db, mock, {});
    await router.generateText({
      domainId,
      tier: "worker",
      pipelineOrAgent: "x",
      prompt: "hi",
    });
    const debug = await db.execute(sql`SELECT id FROM llm_usage_debug`);
    const list = Array.isArray(debug) ? debug : debug.rows;
    expect(list).toHaveLength(0);
  });
});

describe("LlmRouter — generateObject round-trip", () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await seedDomain(db, {
      llmPolicy: {
        thinker: { provider: "openai", model: "gpt-4o" },
        worker: { provider: "openai", model: "gpt-4o-mini" },
        light: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
  });

  it("parses the provider's JSON response with the caller's Zod schema", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "classify" },
      response: {
        text: JSON.stringify({ category: "doc", priority: 2 }),
        tokensIn: 8,
        tokensOut: 4,
      },
    });
    const { router } = newRouter(db, mock);
    const out = await router.generateObject({
      domainId,
      tier: "worker",
      pipelineOrAgent: "classify",
      prompt: "classify this",
      schema: z.object({
        category: z.string(),
        priority: z.number().int(),
      }),
    });
    expect(out.object).toEqual({ category: "doc", priority: 2 });
  });

  it("throws LlmProviderError when provider output fails schema validation", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "classify" },
      response: {
        text: JSON.stringify({ wrong: "shape" }),
        tokensIn: 8,
        tokensOut: 4,
      },
    });
    const { router } = newRouter(db, mock);
    await expect(
      router.generateObject({
        domainId,
        tier: "worker",
        pipelineOrAgent: "classify",
        prompt: "classify this",
        schema: z.object({ category: z.string(), priority: z.number() }),
      }),
    ).rejects.toThrow(LlmProviderError);
  });
});

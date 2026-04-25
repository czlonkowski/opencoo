/**
 * pglite test fixture for classifier tests. Extends the intake
 * fixture with the `llm_usage` + `llm_usage_debug` tables the
 * LlmRouter writes to from `recordUsage`. Per CLAUDE.md
 * schema-ownership the source-of-truth schema lives in
 * @opencoo/shared/db/schema; we mirror the DDL needed for these
 * tests rather than running the whole drizzle migration set
 * (the @opencoo/shared/drizzle SQL files use type modifiers and
 * features the test fixture doesn't need).
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";

import * as schema from "@opencoo/shared/db/schema";

export type ClassifierTestDb = PgliteDatabase<typeof schema>;

const DDL = `
  -- enums
  CREATE TYPE intake_status AS ENUM ('pending', 'classified', 'skipped');
  CREATE TYPE error_class AS ENUM ('transient', 'upstream-quota', 'validation');
  CREATE TYPE domain_class AS ENUM ('knowledge', 'catalog-workflows', 'catalog-skills');
  CREATE TYPE governance_cadence AS ENUM ('continuous', 'weekly', 'monthly');
  CREATE TYPE review_mode AS ENUM ('auto', 'review-required');
  CREATE TYPE llm_engine AS ENUM ('ingestion', 'self-op');
  CREATE TYPE llm_tier AS ENUM ('thinker', 'worker', 'light');

  -- minimal domains
  CREATE TABLE domains (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL UNIQUE,
    name text NOT NULL,
    class domain_class DEFAULT 'knowledge' NOT NULL,
    locale text DEFAULT 'en' NOT NULL,
    governance_cadence governance_cadence DEFAULT 'continuous' NOT NULL,
    review_role text,
    llm_policy jsonb DEFAULT '{}'::jsonb NOT NULL,
    llm_budget_monthly_cap_usd numeric(10, 2),
    retention_days integer,
    worldview_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- llm_usage (router writes one row per call)
  CREATE TABLE llm_usage (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    timestamp timestamp with time zone DEFAULT now() NOT NULL,
    engine llm_engine NOT NULL,
    tier llm_tier NOT NULL,
    model text NOT NULL,
    pipeline_or_agent text NOT NULL,
    document_id text,
    run_id uuid,
    domain_id uuid REFERENCES domains(id) ON DELETE SET NULL,
    tokens_in integer NOT NULL,
    tokens_out integer NOT NULL,
    cost_usd numeric(10, 6) NOT NULL,
    latency_ms integer NOT NULL,
    prompt_version text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- llm_usage_debug (router writes one row per call when LLM_DEBUG_LOG=1)
  CREATE TABLE llm_usage_debug (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    usage_id uuid NOT NULL REFERENCES llm_usage(id) ON DELETE CASCADE,
    prompt_text text NOT NULL,
    response_text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );
`;

export interface ClassifierFixture {
  readonly db: ClassifierTestDb;
  readonly domainId: string;
}

export async function freshClassifierDb(): Promise<ClassifierFixture> {
  const pg = new PGlite();
  await pg.exec(DDL);
  const db: ClassifierTestDb = drizzle(pg, { schema });

  const domainResult = await pg.query<{ id: string }>(
    `INSERT INTO domains (slug, name) VALUES ('test-domain', 'Test Domain') RETURNING id`,
  );
  const domainId = domainResult.rows[0]!.id;

  return { db, domainId };
}

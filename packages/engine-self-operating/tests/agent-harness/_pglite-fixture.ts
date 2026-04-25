/**
 * pglite test fixture for agent-harness tests. Uses the same
 * shared-schema-driven pattern as the engine-ingestion pipeline
 * fixture (PR 17 copilot followup): walk every PgEnum exported
 * from `@opencoo/shared/db/schema` and emit
 * `CREATE TYPE … AS ENUM(...)` so the fixture stays in lockstep
 * with the source-of-truth schema, plus the table DDL for
 * domains, agent_definitions, agent_instances, agent_runs,
 * llm_usage(+_debug) — the four tables the harness reads/writes.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { isPgEnum, type PgEnum } from "drizzle-orm/pg-core";

import * as schema from "@opencoo/shared/db/schema";

export type AgentTestDb = PgliteDatabase<typeof schema>;

function buildEnumsDdl(): string {
  const lines: string[] = [];
  for (const value of Object.values(schema)) {
    if (isPgEnum(value)) {
      const e = value as PgEnum<[string, ...string[]]>;
      const literals = e.enumValues
        .map((v) => `'${v.replace(/'/g, "''")}'`)
        .join(", ");
      lines.push(`CREATE TYPE "${e.enumName}" AS ENUM (${literals});`);
    }
  }
  return lines.join("\n");
}

const TABLES_DDL = `
  -- domains (FK target via agent_runs, llm_usage)
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

  -- agent_definitions (metadata mirror — harness UPSERTs at boot)
  CREATE TABLE agent_definitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL UNIQUE,
    version text NOT NULL,
    description text NOT NULL,
    output_schema_name text NOT NULL,
    default_memory jsonb DEFAULT '{}'::jsonb NOT NULL,
    registered_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- agent_instances
  CREATE TABLE agent_instances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    definition_slug text NOT NULL,
    name text NOT NULL,
    scope_domain_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    output_channel_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    schedule_cron text,
    memory jsonb DEFAULT '{}'::jsonb NOT NULL,
    locale text DEFAULT 'en' NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_instances_definition_slug_name_unique UNIQUE (definition_slug, name)
  );

  -- agent_runs (the carve-out target — single guarded UPDATE)
  CREATE TABLE agent_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    definition_slug text NOT NULL,
    instance_id uuid NOT NULL REFERENCES agent_instances(id) ON DELETE RESTRICT,
    trigger agent_trigger NOT NULL,
    inputs jsonb DEFAULT '{}'::jsonb NOT NULL,
    tool_calls jsonb DEFAULT '[]'::jsonb NOT NULL,
    output jsonb,
    skills_used jsonb DEFAULT '[]'::jsonb NOT NULL,
    tokens_in integer DEFAULT 0 NOT NULL,
    tokens_out integer DEFAULT 0 NOT NULL,
    cost_usd numeric(10, 6) DEFAULT '0' NOT NULL,
    latency_ms integer DEFAULT 0 NOT NULL,
    status agent_run_status NOT NULL,
    error_class error_class,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- llm_usage (LlmRouter writes here when the harness invokes it)
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

  CREATE TABLE llm_usage_debug (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    usage_id uuid NOT NULL REFERENCES llm_usage(id) ON DELETE CASCADE,
    prompt_text text NOT NULL,
    response_text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );
`;

export interface AgentFixture {
  readonly db: AgentTestDb;
  readonly raw: PGlite;
  readonly domainId: string;
}

export interface FreshOptions {
  readonly definitionSlug?: string;
  readonly instanceName?: string;
  readonly memory?: Record<string, unknown>;
}

export interface SeededInstance {
  readonly instanceId: string;
  readonly definitionSlug: string;
}

export async function freshAgentDb(): Promise<AgentFixture> {
  const pg = new PGlite();
  await pg.exec(buildEnumsDdl());
  await pg.exec(TABLES_DDL);
  const db: AgentTestDb = drizzle(pg, { schema });

  const domainResult = await pg.query<{ id: string }>(
    `INSERT INTO domains (slug, name) VALUES ('test-domain', 'Test Domain') RETURNING id`,
  );
  const domainId = domainResult.rows[0]!.id;

  return { db, raw: pg, domainId };
}

export async function seedAgentInstance(
  fixture: AgentFixture,
  opts: FreshOptions = {},
): Promise<SeededInstance> {
  const definitionSlug = opts.definitionSlug ?? "heartbeat";
  const instanceName = opts.instanceName ?? "default";
  const memory = JSON.stringify(opts.memory ?? { type: "none" });
  const result = await fixture.raw.query<{ id: string }>(
    `INSERT INTO agent_instances
       (definition_slug, name, scope_domain_ids, memory, locale, enabled)
     VALUES ($1, $2, $3::uuid[], $4::jsonb, 'en', true)
     RETURNING id`,
    [definitionSlug, instanceName, [fixture.domainId], memory],
  );
  return { instanceId: result.rows[0]!.id, definitionSlug };
}

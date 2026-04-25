/**
 * Load an `agent_instances` row by id (or by definition_slug +
 * name). The harness uses this to resolve the per-deployment
 * config: which definition to run, scope domains, output
 * channels, schedule, memory config, locale.
 *
 * Per the planner's reality check 6 (instances scope-by-domain
 * not binding): scope is uuid[] of domain ids, NOT a single
 * binding. The harness later joins with `domains` for the
 * llm_policy at LLM-call time via the LlmRouter.
 */

import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { AgentInstanceNotFoundError } from "./errors.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

interface ExecResult<R> {
  readonly rows: R[];
}

export interface AgentInstance {
  readonly id: string;
  readonly definitionSlug: string;
  readonly name: string;
  readonly scopeDomainIds: readonly string[];
  readonly outputChannelIds: ReadonlyArray<{
    readonly adapter_slug: string;
    readonly config: Record<string, unknown>;
  }>;
  readonly scheduleCron: string | null;
  readonly memory: Record<string, unknown>;
  readonly locale: "en" | "pl" | "auto";
  readonly enabled: boolean;
}

interface InstanceRow {
  id: string;
  definition_slug: string;
  name: string;
  scope_domain_ids: string[];
  output_channel_ids: Array<{
    adapter_slug: string;
    config: Record<string, unknown>;
  }>;
  schedule_cron: string | null;
  memory: Record<string, unknown>;
  locale: string;
  enabled: boolean;
}

function toInstance(row: InstanceRow): AgentInstance {
  const localeRaw = row.locale ?? "auto";
  const locale: "en" | "pl" | "auto" =
    localeRaw === "en" || localeRaw === "pl" ? localeRaw : "auto";
  return {
    id: row.id,
    definitionSlug: row.definition_slug,
    name: row.name,
    scopeDomainIds: [...(row.scope_domain_ids ?? [])],
    outputChannelIds: [...(row.output_channel_ids ?? [])],
    scheduleCron: row.schedule_cron,
    memory: row.memory ?? {},
    locale,
    enabled: row.enabled,
  };
}

export async function loadInstanceById(
  db: Db,
  instanceId: string,
): Promise<AgentInstance> {
  const result = (await db.execute(sql`
    SELECT id::text AS id,
           definition_slug,
           name,
           scope_domain_ids,
           output_channel_ids,
           schedule_cron,
           memory,
           locale,
           enabled
    FROM agent_instances
    WHERE id = ${instanceId}::uuid AND enabled = true
  `)) as unknown as ExecResult<InstanceRow>;
  const row = result.rows[0];
  if (row === undefined) {
    throw new AgentInstanceNotFoundError(instanceId);
  }
  return toInstance(row);
}

export async function loadInstanceBySlugAndName(
  db: Db,
  definitionSlug: string,
  name: string,
): Promise<AgentInstance | null> {
  const result = (await db.execute(sql`
    SELECT id::text AS id,
           definition_slug,
           name,
           scope_domain_ids,
           output_channel_ids,
           schedule_cron,
           memory,
           locale,
           enabled
    FROM agent_instances
    WHERE definition_slug = ${definitionSlug}
      AND name = ${name}
      AND enabled = true
  `)) as unknown as ExecResult<InstanceRow>;
  const row = result.rows[0];
  if (row === undefined) return null;
  return toInstance(row);
}

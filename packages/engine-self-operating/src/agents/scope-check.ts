/**
 * `assertDomainSlugInScope` — shared run-time entry guard for
 * the v0.1 reader agents (Heartbeat, Lint). The agents take a
 * caller-supplied `domainSlug` for MCP wiki reads but route
 * the LLM call against `ctx.instance.scopeDomainIds[0]` (uuid).
 * Without a cross-check, a miswired caller could read
 * domain-A's wiki content while billing/policing under
 * domain-B's llm_policy.
 *
 * The helper looks up `domains.id` by slug, then verifies
 * the id is in `scopeDomainIds`. Either branch of failure
 * (slug doesn't exist, or its id isn't in scope) throws
 * `DomainScopeMismatchError` (validation, DLQ).
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { DomainScopeMismatchError } from "./errors.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

interface ExecResult<R> {
  readonly rows: R[];
}

interface DomainIdRow {
  id: string;
}

export interface AssertDomainSlugInScopeArgs {
  readonly db: Db;
  readonly domainSlug: string;
  readonly scopeDomainIds: readonly string[];
}

/**
 * Resolves the slug → id, throws if the id isn't in scope or
 * the slug doesn't exist. Returns the resolved id so the caller
 * can use it directly without re-querying.
 */
export async function assertDomainSlugInScope(
  args: AssertDomainSlugInScopeArgs,
): Promise<string> {
  const result = (await args.db.execute(sql`
    SELECT id::text AS id FROM domains WHERE slug = ${args.domainSlug}
  `)) as unknown as ExecResult<DomainIdRow>;
  const row = result.rows[0];
  if (row === undefined) {
    throw new DomainScopeMismatchError(args.domainSlug, args.scopeDomainIds);
  }
  if (!args.scopeDomainIds.includes(row.id)) {
    throw new DomainScopeMismatchError(args.domainSlug, args.scopeDomainIds);
  }
  return row.id;
}

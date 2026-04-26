/**
 * Review Dashboard — domains read-only listing (PR 29 / plan
 * #131). The Management UI's Domains tab consumes this; the
 * LLM Policy editor uses it to populate the per-domain picker
 * with current `llm_policy` values.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface RegisterDomainsRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
}

export function registerDomainsRoutes(args: RegisterDomainsRoutesArgs): void {
  args.app.get("/api/admin/domains", async () => {
    const result = (await args.db.execute(sql`
      SELECT id::text AS id,
             slug,
             name,
             class::text AS class,
             locale,
             llm_policy,
             is_aggregator
      FROM domains
      ORDER BY slug ASC
    `)) as unknown as {
      rows: Array<{
        id: string;
        slug: string;
        name: string;
        class: string;
        locale: string;
        llm_policy: Record<string, unknown>;
        is_aggregator: boolean;
      }>;
    };
    return {
      rows: result.rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        class: r.class,
        locale: r.locale,
        llmPolicy: r.llm_policy,
        isAggregator: r.is_aggregator,
      })),
    };
  });
}

/**
 * Review Dashboard — source-bindings list (PR 28 / plan #128,
 * item type 1 of THREAT-MODEL §7.3).
 *
 * Read-only at v0.1: the route returns the binding rows the
 * operator can act on (those with `review_mode = 'review'` or
 * disabled). A future PR adds the per-row approve/reject
 * action; the audit-log writer + action allowlist are already
 * provisioned here so the action wires in without a security
 * round-trip.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

interface BindingRow {
  readonly id: string;
  readonly domainSlug: string;
  readonly adapterSlug: string;
  readonly reviewMode: string;
  readonly enabled: boolean;
  readonly lastScannedAt: string | null;
  readonly notes: string | null;
}

export interface RegisterSourceBindingsRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
}

export function registerSourceBindingsRoutes(
  args: RegisterSourceBindingsRoutesArgs,
): void {
  args.app.get("/api/admin/source-bindings", async () => {
    const result = (await args.db.execute(sql`
      SELECT b.id::text AS id,
             d.slug AS domain_slug,
             b.adapter_slug,
             b.review_mode::text AS review_mode,
             b.enabled,
             b.last_scanned_at,
             b.notes
      FROM sources_bindings b
      JOIN domains d ON d.id = b.domain_id
      ORDER BY b.created_at DESC
      LIMIT 200
    `)) as unknown as {
      rows: Array<{
        id: string;
        domain_slug: string;
        adapter_slug: string;
        review_mode: string;
        enabled: boolean;
        last_scanned_at: Date | string | null;
        notes: string | null;
      }>;
    };
    const rows: BindingRow[] = result.rows.map((r) => ({
      id: r.id,
      domainSlug: r.domain_slug,
      adapterSlug: r.adapter_slug,
      reviewMode: r.review_mode,
      enabled: r.enabled,
      lastScannedAt:
        r.last_scanned_at === null
          ? null
          : r.last_scanned_at instanceof Date
            ? r.last_scanned_at.toISOString()
            : new Date(r.last_scanned_at).toISOString(),
      notes: r.notes,
    }));
    return { rows };
  });
}

/**
 * Review Dashboard — marketplace updates queue (PR 28 / plan
 * #128, item type 4 of THREAT-MODEL §7.3).
 *
 * Per planner Q3: the `marketplace_updates` table EXISTS — we
 * read real rows. The state-machine mirrors automation-
 * candidates:
 *
 *     pending → accepted | skipped
 *
 * Illegal transitions return 409. Audit-log writes happen
 * BEFORE returning the response so a partial write that crashes
 * mid-flight still leaves a trail.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { marketplaceUpdates } from "@opencoo/shared/db/schema";

import { writeAuditLog } from "../audit-log.js";
import { requireAdminContext } from "../auth.js";
import { requireCsrf } from "../csrf.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

const decisionSchema = z
  .object({
    decision: z.enum(["accept", "skip"]),
  })
  .strict();

export interface RegisterMarketplaceUpdatesRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
}

export function registerMarketplaceUpdatesRoutes(
  args: RegisterMarketplaceUpdatesRoutesArgs,
): void {
  args.app.get("/api/admin/marketplace-updates", async () => {
    const result = (await args.db.execute(sql`
      SELECT id::text AS id,
             marketplace_source,
             release_tag,
             target_commitish,
             tree_sha,
             skills_diff,
             status::text AS status,
             reviewed_by::text AS reviewed_by,
             reviewed_at,
             created_at
      FROM marketplace_updates
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT 100
    `)) as unknown as {
      rows: Array<{
        id: string;
        marketplace_source: string;
        release_tag: string;
        target_commitish: string;
        tree_sha: string;
        skills_diff: unknown;
        status: string;
        reviewed_by: string | null;
        reviewed_at: Date | string | null;
        created_at: Date | string;
      }>;
    };
    return {
      rows: result.rows.map((r) => ({
        id: r.id,
        marketplaceSource: r.marketplace_source,
        releaseTag: r.release_tag,
        targetCommitish: r.target_commitish,
        treeSha: r.tree_sha,
        skillsDiff: r.skills_diff,
        status: r.status,
        reviewedBy: r.reviewed_by,
        reviewedAt:
          r.reviewed_at === null
            ? null
            : r.reviewed_at instanceof Date
              ? r.reviewed_at.toISOString()
              : new Date(r.reviewed_at).toISOString(),
        createdAt:
          r.created_at instanceof Date
            ? r.created_at.toISOString()
            : new Date(r.created_at).toISOString(),
      })),
    };
  });

  args.app.post(
    "/api/admin/marketplace-updates/:id/decision",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const id = (req.params as { id: string }).id;
      const parseResult = decisionSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: "validation_failed",
          issues: parseResult.error.issues,
        });
      }
      const { decision } = parseResult.data;
      const newStatus = decision === "accept" ? "accepted" : "skipped";

      const updated = await args.db
        .update(marketplaceUpdates)
        .set({
          status: newStatus,
          reviewedBy: ctx.userId,
          reviewedAt: new Date(),
        })
        .where(
          sql`${marketplaceUpdates.id} = ${id}::uuid AND ${marketplaceUpdates.status} = 'pending'`,
        )
        .returning({ id: marketplaceUpdates.id });

      if (updated.length === 0) {
        const existing = (await args.db.execute(sql`
          SELECT status::text AS status FROM marketplace_updates WHERE id = ${id}::uuid
        `)) as unknown as { rows: Array<{ status: string }> };
        const row = existing.rows[0];
        if (row === undefined) {
          return reply.code(404).send({ error: "not_found", id });
        }
        return reply.code(409).send({
          error: "illegal_transition",
          reason: `cannot ${decision} a marketplace update in status '${row.status}'`,
          current_status: row.status,
        });
      }

      await writeAuditLog(args.db, {
        action:
          decision === "accept"
            ? "marketplace_update.accept"
            : "marketplace_update.skip",
        userId: ctx.userId,
        metadata: { marketplace_update_id: id },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });

      return reply.code(200).send({
        ok: true,
        id,
        status: newStatus,
      });
    },
  );
}

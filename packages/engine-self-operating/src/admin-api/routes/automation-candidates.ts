/**
 * Review Dashboard — automation-candidates queue (PR 28 / plan
 * #128, item type 3 of THREAT-MODEL §7.3).
 *
 * Surfacer-produced rows arrive at `status = 'proposed'`. The
 * operator approves (sends them to Builder) or rejects (DLQs).
 * The state-machine is intentionally minimal:
 *
 *     proposed → approved | rejected
 *
 * Any other transition (re-approving an already-approved row,
 * rejecting an already-rejected row, or attempting to step
 * 'built' / 'skipped' from this surface) returns 409 — the
 * operator gets a clear signal that the queue moved while they
 * weren't looking. Decision Q8.
 */
import { eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { automationCandidates } from "@opencoo/shared/db/schema";

import { writeAuditLog } from "../audit-log.js";
import { requireAdminContext } from "../auth.js";
import { requireCsrf } from "../csrf.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

const decisionSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    rationale: z.string().min(1).max(2000).optional(),
  })
  .strict();

export interface RegisterAutomationCandidatesRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
}

export function registerAutomationCandidatesRoutes(
  args: RegisterAutomationCandidatesRoutesArgs,
): void {
  // List proposed candidates.
  args.app.get("/api/admin/automation-candidates", async () => {
    const result = (await args.db.execute(sql`
      SELECT id::text AS id,
             surfacer_run_id::text AS surfacer_run_id,
             source_page_refs,
             proposal,
             status::text AS status,
             rationale,
             reviewed_by::text AS reviewed_by,
             reviewed_at,
             created_at
      FROM automation_candidates
      WHERE status = 'proposed'
      ORDER BY created_at DESC
      LIMIT 100
    `)) as unknown as {
      rows: Array<{
        id: string;
        surfacer_run_id: string;
        source_page_refs: unknown;
        proposal: unknown;
        status: string;
        rationale: string | null;
        reviewed_by: string | null;
        reviewed_at: Date | string | null;
        created_at: Date | string;
      }>;
    };
    return {
      rows: result.rows.map((r) => ({
        id: r.id,
        surfacerRunId: r.surfacer_run_id,
        sourcePageRefs: r.source_page_refs,
        proposal: r.proposal,
        status: r.status,
        rationale: r.rationale,
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

  // Approve / reject one candidate.
  args.app.post(
    "/api/admin/automation-candidates/:id/decision",
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
      const { decision, rationale } = parseResult.data;
      const newStatus = decision === "approve" ? "approved" : "rejected";

      // State-machine guard: only `proposed → approved | rejected`
      // is sanctioned (Q8). Any other current status →
      // 409. The UPDATE is conditioned on the source state
      // so the transition is atomic — concurrent operators
      // racing the queue can't both flip the same row.
      const updated = await args.db
        .update(automationCandidates)
        .set({
          status: newStatus,
          rationale: rationale ?? null,
          reviewedBy: ctx.userId,
          reviewedAt: new Date(),
        })
        .where(
          sql`${automationCandidates.id} = ${id}::uuid AND ${automationCandidates.status} = 'proposed'`,
        )
        .returning({ id: automationCandidates.id });

      if (updated.length === 0) {
        // Either the row doesn't exist or it isn't in the
        // 'proposed' state. Inspect to give a clearer signal.
        const existing = (await args.db.execute(sql`
          SELECT status::text AS status FROM automation_candidates WHERE id = ${id}::uuid
        `)) as unknown as { rows: Array<{ status: string }> };
        const row = existing.rows[0];
        if (row === undefined) {
          return reply.code(404).send({
            error: "not_found",
            id,
          });
        }
        return reply.code(409).send({
          error: "illegal_transition",
          reason: `cannot ${decision} a candidate in status '${row.status}'`,
          current_status: row.status,
        });
      }

      await writeAuditLog(args.db, {
        action:
          decision === "approve"
            ? "automation_candidate.approve"
            : "automation_candidate.reject",
        userId: ctx.userId,
        metadata: {
          candidate_id: id,
          ...(rationale !== undefined ? { rationale } : {}),
        },
        sourceIp: req.ip,
        userAgent: extractUserAgent(req.headers["user-agent"]),
      });

      return reply.code(200).send({
        ok: true,
        id,
        status: newStatus,
      });
    },
  );

  // Avoid an unused-locals warning when the import is only
  // referenced inside the .where() — eq is reserved for future
  // multi-condition updates that compose better with eq() than
  // sql``.
  void eq;
}

function extractUserAgent(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

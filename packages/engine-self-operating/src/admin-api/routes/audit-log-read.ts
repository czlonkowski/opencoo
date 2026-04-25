/**
 * Review Dashboard — audit-log read endpoint (PR 28 / plan
 * #128, planner Q4 — IN this PR).
 *
 * `GET /api/admin/audit-log?limit=…&offset=…` — paged.
 * Operators triage their own + peers' actions.
 *
 * The read itself is recorded as an audit-log entry
 * (`audit_log.read`) — operator-pulling-history is itself
 * visible to the next reviewer. That self-recording prevents a
 * silent reconnaissance pattern where an operator browses the
 * audit trail without leaving a footprint.
 */
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { readAuditLog, writeAuditLog } from "../audit-log.js";
import { requireAdminContext } from "../auth.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export interface RegisterAuditLogReadRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
}

export function registerAuditLogReadRoutes(
  args: RegisterAuditLogReadRoutesArgs,
): void {
  args.app.get("/api/admin/audit-log", async (req, reply) => {
    const ctx = requireAdminContext(req);
    const parseResult = querySchema.safeParse(req.query);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: "validation_failed",
        issues: parseResult.error.issues,
      });
    }
    const { limit, offset } = parseResult.data;
    const rows = await readAuditLog(args.db, { limit, offset });

    // Self-record the read so the trail can't be mined silently.
    await writeAuditLog(args.db, {
      action: "audit_log.read",
      userId: ctx.userId,
      metadata: { limit, offset, returned_count: rows.length },
      sourceIp: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return reply.code(200).send({ rows });
  });
}

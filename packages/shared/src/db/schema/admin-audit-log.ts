import { index, jsonb, pgTable, text } from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId, restrictFk } from "./columns.js";
import { users } from "./users.js";

/**
 * Append-only audit log for every admin-API state-changing action
 * (PR 28 / plan #128, THREAT-MODEL §3.13). Every state-changing
 * route writes ONE row per request, BEFORE returning the
 * response — that ordering means a partial write that crashes
 * mid-flight still leaves an audit trail.
 *
 * APPEND-ONLY per THREAT-MODEL §2 invariant 8. The
 * `opencoo/no-update-append-only` ESLint rule enforces this at
 * build-time; the writer in `admin-api/audit-log.ts` only ever
 * INSERTs.
 *
 * Per planner Q4: this PR includes the read endpoint
 * `GET /api/admin/audit-log`. Operators triage their own
 * actions; a separate analytics surface lands later.
 *
 * `action` is action-allowlist Zod-validated at the writer to
 * prevent free-form text from bypassing the audit grep. The
 * allowlist literal is the source of truth for the writer; this
 * column stays `text` (the enum lives in TS, not the DB) so a
 * future v2 action does not require a migration.
 *
 * `metadata` is a free-form jsonb blob — typically the request
 * body shape, the resolved domain id, the candidate id, etc.
 * NEVER carries credential bytes; the writer (typed
 * `AuditMetadata` in admin-api/audit-log.ts) constrains the
 * accepted shapes.
 */
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: primaryKeyId(),
    /** Action verb from the action-allowlist enum in
     *  admin-api/audit-log.ts. */
    action: text("action").notNull(),
    /** User who performed the action. Resolved server-side via
     *  the `verifyAdmin` preHandler — never trusted from the
     *  client. */
    userId: restrictFk("user_id", () => users.id),
    /** Free-form metadata. Constrained to known shapes by the
     *  writer (`AuditMetadata` discriminated union). */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    /** Source IP of the request — populated from the Fastify
     *  request's `request.ip`. Useful for ops triage. */
    sourceIp: text("source_ip"),
    /** User-Agent header (truncated to 256 bytes by the writer). */
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [
    index("admin_audit_log_action_created_at_idx").on(
      t.action,
      t.createdAt,
    ),
    index("admin_audit_log_user_id_created_at_idx").on(
      t.userId,
      t.createdAt,
    ),
  ],
);

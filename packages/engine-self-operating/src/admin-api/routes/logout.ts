/**
 * Logout endpoint (PR 29 / plan #131, decision Q13).
 *
 * `POST /api/admin/logout` — clears the session + CSRF cookies
 * server-side and writes a `session.logout` audit row. The UI
 * also clears the PAT from sessionStorage; this server-side
 * cookie clear is belt-and-suspenders for clients that don't
 * (e.g. an operator who closes the tab via the OS rather than
 * the UI's logout button).
 */
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";

import { writeAuditLog } from "../audit-log.js";
import { requireAdminContext } from "../auth.js";
import { requireCsrf } from "../csrf.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface RegisterLogoutRouteArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
}

export function registerLogoutRoute(args: RegisterLogoutRouteArgs): void {
  args.app.post(
    "/api/admin/logout",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      // Set-Cookie with Max-Age=0 clears both cookies on the
      // /api/admin scope. Browsers treat the matching name +
      // path as a clear directive.
      reply.header("set-cookie", [
        "opencoo_session=; Path=/api/admin; SameSite=Strict; HttpOnly; Secure; Max-Age=0",
        "opencoo_csrf=; Path=/api/admin; SameSite=Strict; Secure; Max-Age=0",
      ]);
      await writeAuditLog(args.db, {
        action: "session.logout",
        userId: ctx.userId,
        metadata: { username: ctx.username },
        sourceIp: req.ip,
        userAgent: extractUserAgent(req.headers["user-agent"]),
      });
      return reply.code(200).send({ ok: true });
    },
  );
}

function extractUserAgent(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

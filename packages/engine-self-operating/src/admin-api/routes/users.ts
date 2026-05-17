/**
 * User-self admin routes (PR-C2, phase-a appendix #16 wave-16).
 *
 *   PATCH /api/admin/users/me/locale
 *     Body: `{ locale: 'en' | 'pl' }`. Flips the caller's
 *     `users.locale_preference` row to the supplied locale. Two-
 *     tier persistence: the SPA writes localStorage first (the
 *     in-session SoT) then PATCHes here (the DB SoT at login).
 *     Audit verb: `user.set_locale_preference`; row written
 *     BEFORE the UPDATE per THREAT-MODEL §3.5 audit-write-before-
 *     mutate invariant.
 *
 * Threat-model:
 *   - admin-team gated by the verifyAdmin preHandler wrapping
 *     every /api/admin/* route (THREAT-MODEL §3.13).
 *   - CSRF-protected via `requireCsrf` (state-changing route).
 *   - Self-only: the route always mutates the caller's row
 *     resolved from `req.adminContext.userId` — there is no
 *     `:userId` path parameter so an attacker who somehow forges
 *     a session cannot pivot to flipping another operator's
 *     preference.
 *   - Locale value is constrained to {'en','pl'} at the Zod
 *     boundary; the DB CHECK rejects bypass attempts via direct
 *     write.
 *   - No operator-supplied freeform text enters audit metadata
 *     (the locale is a closed enum; the username comes from the
 *     verifyAdmin context, not the body).
 *   - PAT bytes NEVER appear in audit metadata or response.
 *
 * Audit metadata shape:
 *   {
 *     user_id: <caller's UUID>,
 *     new_locale: 'en' | 'pl',
 *     caller_username: <resolved gitea username>,
 *   }
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { writeAuditLog } from "../audit-log.js";
import { requireAdminContext } from "../auth.js";
import { requireCsrf } from "../csrf.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Closed set matching both the DB CHECK and the UI's two-locale
 *  shape. Wave-15 ships en + pl; future locales (e.g. de, fr) land
 *  via a coordinated migration + UI sweep. */
const LOCALE_VALUES = ["en", "pl"] as const;

const patchLocaleSchema = z
  .object({
    locale: z.enum(LOCALE_VALUES),
  })
  .strict();

export interface RegisterUsersRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
}

export function registerUsersRoutes(args: RegisterUsersRoutesArgs): void {
  args.app.patch(
    "/api/admin/users/me/locale",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const parsed = patchLocaleSchema.safeParse(req.body);
      if (!parsed.success) {
        // 422 (not 400) — the request was well-formed JSON but
        // semantically invalid (locale not in the allowed set OR
        // missing). Mirrors the W4 instance-create + W5 retention-
        // override `out_of_range` shape so the UI's error mapper
        // treats it as a field-level validation surface.
        return reply.code(422).send({
          error: "validation_failed",
          issues: parsed.error.issues,
        });
      }

      // Audit-write-before-mutate (THREAT-MODEL §3.5). A crash
      // between the audit-write and the UPDATE leaves the audit
      // row recording operator intent without the side effect —
      // the correct failure mode (forensic trail preserved; the
      // operator can re-attempt). The reverse ordering loses the
      // audit row on a crash and silently mutates state.
      //
      // The user row is GUARANTEED to exist at this point because
      // the verifyAdmin preHandler upserts it on every cache-miss
      // (auth.ts: upsertUserAndTeams). We don't need a SELECT-for-
      // existence pre-flight — the FK target is already there.
      await writeAuditLog(args.db, {
        action: "user.set_locale_preference",
        userId: ctx.userId,
        metadata: {
          user_id: ctx.userId,
          new_locale: parsed.data.locale,
          caller_username: ctx.username,
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });

      const updated = (await args.db.execute(sql`
        UPDATE users
        SET locale_preference = ${parsed.data.locale}
        WHERE id = ${ctx.userId}::uuid
        RETURNING id::text AS id, locale_preference
      `)) as unknown as {
        rows: Array<{ id: string; locale_preference: string | null }>;
      };
      const row = updated.rows[0];
      if (row === undefined) {
        // Defense in depth — verifyAdmin upserts the row before
        // we get here, so a missing user is a server-state bug,
        // not an operator-facing failure mode. Return 500 so the
        // client triages via the audit log + engine logs.
        return reply.code(500).send({ error: "update_returned_no_row" });
      }

      return reply.code(200).send({
        ok: true,
        localePreference: row.locale_preference,
      });
    },
  );
}

/** Read the caller's `locale_preference` for hydration into the
 *  `/api/admin/_csrf` response (PR-C2). NULL means "no preference,
 *  fall back to the client-side detector default" — the SPA reads
 *  null as "do not overwrite localStorage at login". */
export async function readLocalePreference(
  db: Db,
  userId: string,
): Promise<string | null> {
  const r = (await db.execute(sql`
    SELECT locale_preference FROM users WHERE id = ${userId}::uuid LIMIT 1
  `)) as unknown as { rows: Array<{ locale_preference: string | null }> };
  return r.rows[0]?.locale_preference ?? null;
}

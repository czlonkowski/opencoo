import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId } from "./columns.js";
import { userRole } from "./enums.js";

/**
 * `gitea_teams` is the cached list of Gitea team slugs the user
 * belongs to (PR 28 / plan #128). The admin-API's `verifyAdmin`
 * preHandler reconciles team membership against `ADMIN_TEAM_SLUG`
 * env on every request. The runtime source of truth for the
 * recheck is `giteaClient.whoami(pat)` — this column is the
 * persisted CACHE of the latest reconciled team list, with
 * `gitea_teams_refreshed_at` recording the timestamp of the most
 * recent persist. The in-memory PAT-keyed cache (60s TTL) is what
 * gates per-request whoami calls; the column is the durable
 * record so an engine restart doesn't flush the operator's
 * established membership.
 *
 * UI filtering is not authorization — server-side authz on every
 * state-changing route flows through the verifyAdmin preHandler
 * (THREAT-MODEL §3.13). This column persists what verifyAdmin
 * last reconciled, not the per-request decision.
 *
 * The default `'[]'::jsonb` keeps existing rows from the v0.1
 * migration set valid; the admin-API populates the column on
 * first verifyAdmin success.
 */
export const users = pgTable("users", {
  id: primaryKeyId(),
  giteaUsername: text("gitea_username").notNull().unique(),
  role: userRole("role").notNull().default("operator"),
  giteaTeams: jsonb("gitea_teams")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  giteaTeamsRefreshedAt: timestamp("gitea_teams_refreshed_at", {
    withTimezone: true,
  }),
  createdAt: createdAt(),
});

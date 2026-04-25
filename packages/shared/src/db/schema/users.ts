import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId } from "./columns.js";
import { userRole } from "./enums.js";

/**
 * `gitea_teams` is the cached list of Gitea team slugs the user
 * belongs to (PR 28 / plan #128). The admin-API's `verifyAdmin`
 * preHandler reconciles this list against `ADMIN_TEAM_SLUG`
 * env on every request; the cache is refreshed via
 * `giteaClient.whoami(pat)` when `gitea_teams_refreshed_at` is
 * older than 5 minutes (or NULL on a brand-new user).
 *
 * UI filtering is not authorization — server-side authz reads
 * THIS column on every state-changing route (THREAT-MODEL §3.13).
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

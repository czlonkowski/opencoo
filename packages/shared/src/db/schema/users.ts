import { pgTable, text } from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId } from "./columns.js";
import { userRole } from "./enums.js";

export const users = pgTable("users", {
  id: primaryKeyId(),
  giteaUsername: text("gitea_username").notNull().unique(),
  role: userRole("role").notNull().default("operator"),
  createdAt: createdAt(),
});

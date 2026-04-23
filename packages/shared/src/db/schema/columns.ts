import { sql } from "drizzle-orm";
import { timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Canonical column builders reused across every `pgTable`. Centralising
 * these keeps the schema files focused on the columns that make each
 * table distinctive, and guarantees `id` / `created_at` / `updated_at`
 * stay byte-identical in generated migrations (the differ reads the
 * builder output, not this call site).
 */

export const primaryKeyId = () =>
  uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`);

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

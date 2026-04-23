import { sql } from "drizzle-orm";
import {
  customType,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const credentials = pgTable("credentials", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  schemaRef: text("schema_ref").notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  iv: bytea("iv").notNull(),
  aad: bytea("aad").notNull(),
  encryptionVersion: integer("encryption_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
});

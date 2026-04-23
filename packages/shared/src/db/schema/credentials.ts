import { customType, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId } from "./columns.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const credentials = pgTable("credentials", {
  id: primaryKeyId(),
  name: text("name").notNull(),
  schemaRef: text("schema_ref").notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  iv: bytea("iv").notNull(),
  aad: bytea("aad").notNull(),
  encryptionVersion: integer("encryption_version").notNull().default(1),
  createdAt: createdAt(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
});

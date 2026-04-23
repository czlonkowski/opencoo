import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId, restrictFk } from "./columns.js";
import { webhookStatus } from "./enums.js";
import { sourcesBindings } from "./sources-bindings.js";

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: primaryKeyId(),
    provider: text("provider").notNull(),
    eventId: text("event_id"),
    payloadHash: text("payload_hash").notNull(),
    payload: jsonb("payload"),
    signatureOk: boolean("signature_ok").notNull(),
    bindingId: restrictFk("binding_id", () => sourcesBindings.id),
    deliveryCount: integer("delivery_count").notNull().default(1),
    status: webhookStatus("status").notNull().default("pending"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("webhook_events_provider_event_id_unique")
      .on(t.provider, t.eventId)
      .where(sql`${t.eventId} IS NOT NULL`),
    index("webhook_events_received_at_idx").on(t.receivedAt.desc()),
  ],
);

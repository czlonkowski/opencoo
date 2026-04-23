import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
} from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId, updatedAt } from "./columns.js";
import { domainClass, governanceCadence } from "./enums.js";
import type { LlmPolicy } from "../types/llm-policy.js";

export const domains = pgTable(
  "domains",
  {
    id: primaryKeyId(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    class: domainClass("class").notNull().default("knowledge"),
    locale: text("locale").notNull().default("en"),
    governanceCadence: governanceCadence("governance_cadence")
      .notNull()
      .default("continuous"),
    reviewRole: text("review_role"),
    llmPolicy: jsonb("llm_policy")
      .$type<LlmPolicy>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    llmBudgetMonthlyCapUsd: numeric("llm_budget_monthly_cap_usd", {
      precision: 10,
      scale: 2,
    }),
    retentionDays: integer("retention_days"),
    worldviewEnabled: boolean("worldview_enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "domains_slug_format",
      sql`${t.slug} ~ '^[a-z][a-z0-9-]{1,62}$'`,
    ),
    check("domains_locale_allowed", sql`${t.locale} IN ('en', 'pl', 'auto')`),
  ],
);

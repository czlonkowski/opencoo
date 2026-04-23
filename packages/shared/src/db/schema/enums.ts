import { pgEnum } from "drizzle-orm/pg-core";

export const domainClass = pgEnum("domain_class", [
  "knowledge",
  "catalog-workflows",
  "catalog-skills",
]);

export const governanceCadence = pgEnum("governance_cadence", [
  "continuous",
  "nightly",
  "weekly",
  "quarterly",
  "adhoc",
]);

export const reviewMode = pgEnum("review_mode", ["auto", "approve", "review"]);

export const userRole = pgEnum("user_role", ["admin", "operator"]);

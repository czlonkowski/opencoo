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

// --- ingestion-side enums (PR 03) ---

export const intakeStatus = pgEnum("intake_status", [
  "pending",
  "classified",
  "skipped",
]);

export const webhookStatus = pgEnum("webhook_status", [
  "pending",
  "classified",
  "skipped",
  "invalid",
]);

export const errorClass = pgEnum("error_class", [
  "transient",
  "upstream-quota",
  "validation",
]);

export const llmEngine = pgEnum("llm_engine", ["ingestion", "self-op"]);

export const llmTier = pgEnum("llm_tier", ["thinker", "worker", "light"]);

export const catalogClass = pgEnum("catalog_class", [
  "skill",
  "workflow-pattern",
]);

export const catalogCandidateStatus = pgEnum("catalog_candidate_status", [
  "detected",
  "drafted",
  "reviewing",
  "approved",
  "rejected",
  "promoted",
]);

export const guardFailMode = pgEnum("guard_fail_mode", [
  "block",
  "transform",
  "review",
]);

export const erasureAction = pgEnum("erasure_action", [
  "purge_intake",
  "purge_webhooks",
  "purge_llm_debug",
  "recompile_page",
  "delete_page",
]);

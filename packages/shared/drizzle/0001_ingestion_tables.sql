CREATE TYPE "public"."catalog_candidate_status" AS ENUM('detected', 'drafted', 'reviewing', 'approved', 'rejected', 'promoted');--> statement-breakpoint
CREATE TYPE "public"."catalog_class" AS ENUM('skill', 'workflow-pattern');--> statement-breakpoint
CREATE TYPE "public"."erasure_action" AS ENUM('purge_intake', 'purge_webhooks', 'purge_llm_debug', 'recompile_page', 'delete_page');--> statement-breakpoint
CREATE TYPE "public"."error_class" AS ENUM('transient', 'upstream-quota', 'validation');--> statement-breakpoint
CREATE TYPE "public"."guard_fail_mode" AS ENUM('block', 'transform', 'review');--> statement-breakpoint
CREATE TYPE "public"."intake_status" AS ENUM('pending', 'classified', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."llm_engine" AS ENUM('ingestion', 'self-op');--> statement-breakpoint
CREATE TYPE "public"."llm_tier" AS ENUM('thinker', 'worker', 'light');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('pending', 'classified', 'skipped', 'invalid');--> statement-breakpoint
CREATE TABLE "catalog_candidate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"miner_run_id" uuid NOT NULL,
	"catalog_domain_id" uuid NOT NULL,
	"class" "catalog_class" NOT NULL,
	"status" "catalog_candidate_status" DEFAULT 'detected' NOT NULL,
	"pattern_fingerprint" text NOT NULL,
	"evidence_refs" jsonb NOT NULL,
	"draft_payload" jsonb NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "erasure_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"action" "erasure_action" NOT NULL,
	"target_ref" text NOT NULL,
	"executed_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_intake" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"source_doc_id" text NOT NULL,
	"source_revision" text NOT NULL,
	"content_hash" text NOT NULL,
	"status" "intake_status" DEFAULT 'pending' NOT NULL,
	"last_classifier_run_id" text,
	"error_class" "error_class",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingestion_intake_binding_doc_revision_unique" UNIQUE("binding_id","source_doc_id","source_revision")
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"engine" "llm_engine" NOT NULL,
	"tier" "llm_tier" NOT NULL,
	"model" text NOT NULL,
	"pipeline_or_agent" text NOT NULL,
	"document_id" text,
	"run_id" uuid,
	"tokens_in" integer NOT NULL,
	"tokens_out" integer NOT NULL,
	"cost_usd" numeric(10, 6) NOT NULL,
	"latency_ms" integer NOT NULL,
	"prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "miner_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"miner_binding_id" uuid NOT NULL,
	"class" "catalog_class" NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"suppressed_count" integer DEFAULT 0 NOT NULL,
	"tokens_total" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "miner_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_domain_id" uuid NOT NULL,
	"pattern_fingerprint" text NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "miner_suppressions_catalog_domain_fingerprint_unique" UNIQUE("catalog_domain_id","pattern_fingerprint")
);
--> statement-breakpoint
CREATE TABLE "page_citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_slug" text NOT NULL,
	"page_path" text NOT NULL,
	"source_binding_id" uuid NOT NULL,
	"source_ref" text NOT NULL,
	"compiled_by_run_id" uuid,
	"prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redaction_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline" text NOT NULL,
	"domain_id" uuid,
	"binding_id" uuid,
	"guard_slug" text NOT NULL,
	"category" text NOT NULL,
	"pattern_version" text NOT NULL,
	"matched_byte_ranges" jsonb NOT NULL,
	"fail_mode" "guard_fail_mode" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text,
	"payload_hash" text NOT NULL,
	"payload" jsonb,
	"signature_ok" boolean NOT NULL,
	"binding_id" uuid,
	"delivery_count" integer DEFAULT 1 NOT NULL,
	"status" "webhook_status" DEFAULT 'pending' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalog_candidate" ADD CONSTRAINT "catalog_candidate_miner_run_id_miner_runs_id_fk" FOREIGN KEY ("miner_run_id") REFERENCES "public"."miner_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_candidate" ADD CONSTRAINT "catalog_candidate_catalog_domain_id_domains_id_fk" FOREIGN KEY ("catalog_domain_id") REFERENCES "public"."domains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_candidate" ADD CONSTRAINT "catalog_candidate_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_log" ADD CONSTRAINT "erasure_log_binding_id_sources_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."sources_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_log" ADD CONSTRAINT "erasure_log_executed_by_users_id_fk" FOREIGN KEY ("executed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_intake" ADD CONSTRAINT "ingestion_intake_binding_id_sources_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."sources_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "miner_runs" ADD CONSTRAINT "miner_runs_miner_binding_id_sources_bindings_id_fk" FOREIGN KEY ("miner_binding_id") REFERENCES "public"."sources_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "miner_suppressions" ADD CONSTRAINT "miner_suppressions_catalog_domain_id_domains_id_fk" FOREIGN KEY ("catalog_domain_id") REFERENCES "public"."domains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "miner_suppressions" ADD CONSTRAINT "miner_suppressions_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_citations" ADD CONSTRAINT "page_citations_source_binding_id_sources_bindings_id_fk" FOREIGN KEY ("source_binding_id") REFERENCES "public"."sources_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redaction_events" ADD CONSTRAINT "redaction_events_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redaction_events" ADD CONSTRAINT "redaction_events_binding_id_sources_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."sources_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_binding_id_sources_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."sources_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_candidate_status_idx" ON "catalog_candidate" USING btree ("status");--> statement-breakpoint
CREATE INDEX "catalog_candidate_miner_run_id_idx" ON "catalog_candidate" USING btree ("miner_run_id");--> statement-breakpoint
CREATE INDEX "erasure_log_binding_id_created_at_idx" ON "erasure_log" USING btree ("binding_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_usage_timestamp_idx" ON "llm_usage" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "llm_usage_pipeline_or_agent_timestamp_idx" ON "llm_usage" USING btree ("pipeline_or_agent","timestamp");--> statement-breakpoint
CREATE INDEX "miner_runs_miner_binding_id_created_at_idx" ON "miner_runs" USING btree ("miner_binding_id","created_at");--> statement-breakpoint
CREATE INDEX "page_citations_domain_slug_page_path_idx" ON "page_citations" USING btree ("domain_slug","page_path");--> statement-breakpoint
CREATE INDEX "page_citations_source_binding_id_idx" ON "page_citations" USING btree ("source_binding_id");--> statement-breakpoint
CREATE INDEX "redaction_events_pipeline_created_at_idx" ON "redaction_events" USING btree ("pipeline","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_id_unique" ON "webhook_events" USING btree ("provider","event_id") WHERE "webhook_events"."event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "webhook_events_received_at_idx" ON "webhook_events" USING btree ("received_at" DESC NULLS LAST);
CREATE TABLE "llm_usage_debug" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usage_id" uuid NOT NULL,
	"prompt_text" text NOT NULL,
	"response_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "domain_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_usage_debug" ADD CONSTRAINT "llm_usage_debug_usage_id_llm_usage_id_fk" FOREIGN KEY ("usage_id") REFERENCES "public"."llm_usage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_usage_debug_created_at_idx" ON "llm_usage_debug" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE set null ON UPDATE no action;
CREATE TYPE "public"."domain_class" AS ENUM('knowledge', 'catalog-workflows', 'catalog-skills');--> statement-breakpoint
CREATE TYPE "public"."governance_cadence" AS ENUM('continuous', 'nightly', 'weekly', 'quarterly', 'adhoc');--> statement-breakpoint
CREATE TYPE "public"."review_mode" AS ENUM('auto', 'approve', 'review');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'operator');--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"schema_ref" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"aad" "bytea" NOT NULL,
	"encryption_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"class" "domain_class" DEFAULT 'knowledge' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"governance_cadence" "governance_cadence" DEFAULT 'continuous' NOT NULL,
	"review_role" text,
	"llm_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"llm_budget_monthly_cap_usd" numeric(10, 2),
	"retention_days" integer,
	"worldview_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domains_slug_unique" UNIQUE("slug"),
	CONSTRAINT "domains_slug_format" CHECK ("domains"."slug" ~ '^[a-z][a-z0-9-]{1,62}$'),
	CONSTRAINT "domains_locale_allowed" CHECK ("domains"."locale" IN ('en', 'pl', 'auto'))
);
--> statement-breakpoint
CREATE TABLE "sources_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" uuid NOT NULL,
	"adapter_slug" text NOT NULL,
	"source_id" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"allowed_paths" text[] DEFAULT '{}'::text[] NOT NULL,
	"review_mode" "review_mode" DEFAULT 'auto' NOT NULL,
	"schedule_cron" text,
	"credentials_id" uuid,
	"retention_days_override" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_scanned_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gitea_username" text NOT NULL,
	"role" "user_role" DEFAULT 'operator' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_gitea_username_unique" UNIQUE("gitea_username")
);
--> statement-breakpoint
ALTER TABLE "sources_bindings" ADD CONSTRAINT "sources_bindings_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources_bindings" ADD CONSTRAINT "sources_bindings_credentials_id_credentials_id_fk" FOREIGN KEY ("credentials_id") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sources_bindings_domain_id_adapter_slug_idx" ON "sources_bindings" USING btree ("domain_id","adapter_slug");
CREATE TYPE "public"."output_delivery_status" AS ENUM('success', 'transient_failure', 'dlq');--> statement-breakpoint
CREATE TABLE "output_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"output_binding_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"status" "output_delivery_status" NOT NULL,
	"status_code" integer,
	"response_body_excerpt" text,
	"sent_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "output_deliveries_binding_delivery_attempt_unique" ON "output_deliveries" USING btree ("output_binding_id","delivery_id","attempt");
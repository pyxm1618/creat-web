CREATE TYPE "public"."account_subject_status" AS ENUM('active', 'deletion_pending', 'deleted');--> statement-breakpoint
CREATE TABLE "account_subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_user_id" text,
	"status" "account_subject_status" DEFAULT 'active' NOT NULL,
	"pseudonymous_key" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deletion_requested_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "account_subjects_auth_user_id_unique" UNIQUE("auth_user_id"),
	CONSTRAINT "account_subjects_pseudonymous_key_unique" UNIQUE("pseudonymous_key")
);
--> statement-breakpoint
ALTER TABLE "account_subjects" ADD CONSTRAINT "account_subjects_auth_user_id_user_id_fk" FOREIGN KEY ("auth_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
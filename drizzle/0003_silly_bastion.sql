CREATE TYPE "public"."account_deletion_status" AS ENUM('pending', 'processing', 'failed', 'completed');--> statement-breakpoint
CREATE TYPE "public"."account_deletion_step" AS ENUM('requested', 'access_revoked', 'downstream_prepared', 'identity_detached', 'identity_deleted', 'completed');--> statement-breakpoint
CREATE TABLE "account_deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid NOT NULL,
	"auth_user_id" text,
	"status" "account_deletion_status" DEFAULT 'pending' NOT NULL,
	"step" "account_deletion_step" DEFAULT 'requested' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "account_deletion_requests_subject_id_unique" UNIQUE("subject_id")
);
--> statement-breakpoint
CREATE TABLE "auth_security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid,
	"auth_user_id" text,
	"event_type" text NOT NULL,
	"outcome" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_subject_id_account_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."account_subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_auth_user_id_user_id_fk" FOREIGN KEY ("auth_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_security_events" ADD CONSTRAINT "auth_security_events_subject_id_account_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."account_subjects"("id") ON DELETE set null ON UPDATE no action;
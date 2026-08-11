ALTER TABLE "commerce_reconciliation_runs" ADD COLUMN "dedup_key" text;--> statement-breakpoint
CREATE TABLE "payment_reconciliation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	"operator_review_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "payment_reconciliation_job_state_valid" CHECK ("payment_reconciliation_jobs"."state" in ('pending','processing','completed','operator_review','dead_letter')),
	CONSTRAINT "payment_reconciliation_job_environment_valid" CHECK ("payment_reconciliation_jobs"."environment" in ('test','production')),
	CONSTRAINT "payment_reconciliation_job_attempts_nonnegative" CHECK ("payment_reconciliation_jobs"."attempts" >= 0),
	CONSTRAINT "payment_reconciliation_job_lease_consistent" CHECK (("payment_reconciliation_jobs"."state" = 'processing' and "payment_reconciliation_jobs"."lease_owner" is not null and "payment_reconciliation_jobs"."lease_token" is not null and "payment_reconciliation_jobs"."lease_expires_at" is not null) or ("payment_reconciliation_jobs"."state" <> 'processing' and "payment_reconciliation_jobs"."lease_owner" is null and "payment_reconciliation_jobs"."lease_token" is null and "payment_reconciliation_jobs"."lease_expires_at" is null)),
	CONSTRAINT "payment_reconciliation_job_review_reason_consistent" CHECK (("payment_reconciliation_jobs"."state" = 'operator_review' and "payment_reconciliation_jobs"."operator_review_reason" is not null) or ("payment_reconciliation_jobs"."state" <> 'operator_review' and "payment_reconciliation_jobs"."operator_review_reason" is null)),
	CONSTRAINT "payment_reconciliation_job_terminal_time_consistent" CHECK (("payment_reconciliation_jobs"."state" in ('completed','operator_review','dead_letter') and "payment_reconciliation_jobs"."completed_at" is not null) or ("payment_reconciliation_jobs"."state" in ('pending','processing') and "payment_reconciliation_jobs"."completed_at" is null))
);--> statement-breakpoint
ALTER TABLE "payment_reconciliation_jobs" ADD CONSTRAINT "payment_reconciliation_jobs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_reconciliation_run_dedup_uq" ON "commerce_reconciliation_runs" USING btree ("dedup_key") WHERE "commerce_reconciliation_runs"."dedup_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_reconciliation_order_uq" ON "payment_reconciliation_jobs" USING btree ("environment","order_id");--> statement-breakpoint
CREATE INDEX "payment_reconciliation_due_idx" ON "payment_reconciliation_jobs" USING btree ("state","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "payment_reconciliation_reclaim_idx" ON "payment_reconciliation_jobs" USING btree ("state","lease_expires_at");

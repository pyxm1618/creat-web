CREATE TABLE "commerce_command_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid NOT NULL,
	"command_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "commerce_command_type_valid" CHECK ("commerce_command_jobs"."command_type" in ('subscription_cancel','subscription_resume','refund_request')),
	CONSTRAINT "commerce_command_state_valid" CHECK ("commerce_command_jobs"."state" in ('pending','processing','completed','dead_letter'))
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"external_refund_reference" text,
	"idempotency_key" text NOT NULL,
	"currency" text NOT NULL,
	"requested_minor" bigint NOT NULL,
	"succeeded_minor" bigint DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reversal_status" text DEFAULT 'pending' NOT NULL,
	"operator_review_reason" text,
	"provider_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_environment_valid" CHECK ("refunds"."environment" in ('test','production')),
	CONSTRAINT "refund_requested_minor_positive" CHECK ("refunds"."requested_minor" > 0),
	CONSTRAINT "refund_succeeded_minor_valid" CHECK ("refunds"."succeeded_minor" >= 0 and "refunds"."succeeded_minor" <= "refunds"."requested_minor"),
	CONSTRAINT "refund_status_valid" CHECK ("refunds"."status" in ('pending','processing','succeeded','failed','reconciliation_required')),
	CONSTRAINT "refund_reversal_status_valid" CHECK ("refunds"."reversal_status" in ('pending','completed','not_required','reconciliation_required'))
);
--> statement-breakpoint
CREATE TABLE "subscription_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"payment_id" uuid,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'paid' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_period_window_valid" CHECK ("subscription_periods"."period_end" > "subscription_periods"."period_start"),
	CONSTRAINT "subscription_period_state_valid" CHECK ("subscription_periods"."state" in ('paid','refunded','void'))
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"external_order_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"past_due_started_at" timestamp with time zone,
	"past_due_grace_ends_at" timestamp with time zone,
	"grace_policy_version" text,
	"provider_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_environment_valid" CHECK ("subscriptions"."environment" in ('test','production')),
	CONSTRAINT "subscription_status_valid" CHECK ("subscriptions"."status" in ('pending','active','past_due','canceling','canceled','expired','closed')),
	CONSTRAINT "subscription_grace_consistent" CHECK (("subscriptions"."past_due_started_at" is null and "subscriptions"."past_due_grace_ends_at" is null and "subscriptions"."grace_policy_version" is null) or ("subscriptions"."past_due_started_at" is not null and "subscriptions"."past_due_grace_ends_at" is not null and "subscriptions"."grace_policy_version" is not null and "subscriptions"."past_due_grace_ends_at" >= "subscriptions"."past_due_started_at"))
);
--> statement-breakpoint
ALTER TABLE "commerce_products" ADD COLUMN "billing_interval" text;--> statement-breakpoint
ALTER TABLE "commerce_command_jobs" ADD CONSTRAINT "commerce_command_jobs_subject_id_account_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."account_subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_subject_id_account_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."account_subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_periods" ADD CONSTRAINT "subscription_periods_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_periods" ADD CONSTRAINT "subscription_periods_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_subject_id_account_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."account_subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_command_idempotency_uq" ON "commerce_command_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "commerce_command_due_idx" ON "commerce_command_jobs" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_idempotency_uq" ON "refunds" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_environment_external_reference_uq" ON "refunds" USING btree ("environment","external_refund_reference") WHERE "refunds"."external_refund_reference" is not null;--> statement-breakpoint
CREATE INDEX "refund_payment_idx" ON "refunds" USING btree ("payment_id","created_at");--> statement-breakpoint
CREATE INDEX "refund_operator_review_idx" ON "refunds" USING btree ("status","reversal_status");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_period_window_uq" ON "subscription_periods" USING btree ("subscription_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX "subscription_period_payment_idx" ON "subscription_periods" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_order_uq" ON "subscriptions" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_environment_external_order_uq" ON "subscriptions" USING btree ("environment","external_order_id");--> statement-breakpoint
CREATE INDEX "subscription_subject_status_idx" ON "subscriptions" USING btree ("subject_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "subscription_past_due_idx" ON "subscriptions" USING btree ("status","past_due_grace_ends_at");--> statement-breakpoint
ALTER TABLE "commerce_products" ADD CONSTRAINT "commerce_product_billing_interval_valid" CHECK (("commerce_products"."model" = 'one_time' and "commerce_products"."billing_interval" is null) or ("commerce_products"."model" = 'subscription' and "commerce_products"."billing_interval" in ('month','year')));
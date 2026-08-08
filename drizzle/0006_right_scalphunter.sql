CREATE TABLE "commerce_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"model" text NOT NULL,
	"environment" text NOT NULL,
	"provider_product_id" text NOT NULL,
	"currency" text NOT NULL,
	"expected_minor" bigint NOT NULL,
	"fulfillment_key" text NOT NULL,
	"refund_policy_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"active_from" timestamp with time zone DEFAULT now() NOT NULL,
	"active_to" timestamp with time zone,
	CONSTRAINT "commerce_product_expected_minor_positive" CHECK ("commerce_products"."expected_minor" > 0),
	CONSTRAINT "commerce_product_environment_valid" CHECK ("commerce_products"."environment" in ('test','production')),
	CONSTRAINT "commerce_product_model_valid" CHECK ("commerce_products"."model" in ('one_time','subscription'))
);
--> statement-breakpoint
CREATE TABLE "commerce_reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"before_json" jsonb NOT NULL,
	"after_json" jsonb NOT NULL,
	"result" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fulfillment_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "fulfillment_state_valid" CHECK ("fulfillment_jobs"."state" in ('pending','processing','completed','dead_letter'))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expected_currency" text NOT NULL,
	"expected_minor" bigint NOT NULL,
	"checkout_idempotency_key" text NOT NULL,
	"external_checkout_session_id" text,
	"external_order_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	CONSTRAINT "order_expected_minor_positive" CHECK ("orders"."expected_minor" > 0),
	CONSTRAINT "order_environment_valid" CHECK ("orders"."environment" in ('test','production')),
	CONSTRAINT "order_status_valid" CHECK ("orders"."status" in ('pending','paid','canceled','partially_refunded','refunded'))
);
--> statement-breakpoint
CREATE TABLE "payment_webhook_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"dedup_hash" text NOT NULL,
	"event_type" text NOT NULL,
	"signature_valid" boolean NOT NULL,
	"normalized_payload_json" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"payload_size_bytes" integer NOT NULL,
	"raw_payload_ciphertext" "bytea",
	"raw_payload_key_id" text,
	"raw_payload_expires_at" timestamp with time zone,
	"raw_payload_purged_at" timestamp with time zone,
	"retention_class" text NOT NULL,
	"legal_hold_review_at" timestamp with time zone,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "webhook_environment_valid" CHECK ("payment_webhook_inbox"."environment" in ('test','production')),
	CONSTRAINT "webhook_payload_size_nonnegative" CHECK ("payment_webhook_inbox"."payload_size_bytes" >= 0),
	CONSTRAINT "webhook_retention_class_valid" CHECK ("payment_webhook_inbox"."retention_class" in ('normalized_only','transient_encrypted','unresolved_encrypted','invalid_signature')),
	CONSTRAINT "webhook_invalid_signature_no_raw" CHECK ("payment_webhook_inbox"."signature_valid" or ("payment_webhook_inbox"."raw_payload_ciphertext" is null and "payment_webhook_inbox"."raw_payload_key_id" is null and "payment_webhook_inbox"."raw_payload_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"external_payment_id" text NOT NULL,
	"status" text NOT NULL,
	"refund_status" text DEFAULT 'none' NOT NULL,
	"currency" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"provider_created_at" timestamp with time zone,
	"raw_payload_hash" text NOT NULL,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_amount_nonnegative" CHECK ("payments"."amount_minor" >= 0),
	CONSTRAINT "payment_environment_valid" CHECK ("payments"."environment" in ('test','production')),
	CONSTRAINT "payment_status_valid" CHECK ("payments"."status" in ('pending','succeeded','failed','canceled')),
	CONSTRAINT "payment_refund_status_valid" CHECK ("payments"."refund_status" in ('none','partial','refunded','failed'))
);
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_subject_id_account_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."account_subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_id_commerce_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."commerce_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_product_key_version_environment_uq" ON "commerce_products" USING btree ("key","version","environment");--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillment_idempotency_uq" ON "fulfillment_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "fulfillment_due_idx" ON "fulfillment_jobs" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_checkout_idempotency_uq" ON "orders" USING btree ("checkout_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "order_environment_external_order_uq" ON "orders" USING btree ("environment","external_order_id") WHERE "orders"."external_order_id" is not null;--> statement-breakpoint
CREATE INDEX "order_subject_created_idx" ON "orders" USING btree ("subject_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_environment_event_uq" ON "payment_webhook_inbox" USING btree ("environment","provider_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_environment_dedup_uq" ON "payment_webhook_inbox" USING btree ("environment","dedup_hash");--> statement-breakpoint
CREATE INDEX "webhook_due_idx" ON "payment_webhook_inbox" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_environment_external_payment_uq" ON "payments" USING btree ("environment","external_payment_id");--> statement-breakpoint
CREATE INDEX "payment_order_idx" ON "payments" USING btree ("order_id");
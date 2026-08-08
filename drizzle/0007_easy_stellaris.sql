CREATE TABLE "credit_finalization_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"delivery_reference" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "credit_finalization_state_valid" CHECK ("credit_finalization_jobs"."state" in ('pending','processing','completed','dead_letter'))
);
--> statement-breakpoint
CREATE TABLE "credit_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid NOT NULL,
	"credit_type" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"idempotency_key" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "credit_grant_quantity_positive" CHECK ("credit_grants"."quantity" > 0),
	CONSTRAINT "credit_grant_state_valid" CHECK ("credit_grants"."state" in ('active','exhausted','expired','revoked'))
);
--> statement-breakpoint
CREATE TABLE "credit_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid NOT NULL,
	"credit_type" text NOT NULL,
	"grant_id" uuid,
	"reservation_id" uuid,
	"entry_type" text NOT NULL,
	"quantity" integer NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "credit_ledger_quantity_positive" CHECK ("credit_ledger_entries"."quantity" > 0),
	CONSTRAINT "credit_ledger_entry_type_valid" CHECK ("credit_ledger_entries"."entry_type" in ('grant','reserve','release','consume','expire','revoke','adjust_positive','adjust_negative'))
);
--> statement-breakpoint
CREATE TABLE "credit_reservation_allocations" (
	"reservation_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "credit_reservation_allocations_reservation_id_grant_id_pk" PRIMARY KEY("reservation_id","grant_id"),
	CONSTRAINT "credit_allocation_quantity_positive" CHECK ("credit_reservation_allocations"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "credit_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid NOT NULL,
	"credit_type" text NOT NULL,
	"purpose_type" text NOT NULL,
	"purpose_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"idempotency_key" text NOT NULL,
	"terminal_correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"committed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	CONSTRAINT "credit_reservation_quantity_positive" CHECK ("credit_reservations"."quantity" > 0),
	CONSTRAINT "credit_reservation_status_valid" CHECK ("credit_reservations"."status" in ('active','committed','released','expired'))
);
--> statement-breakpoint
ALTER TABLE "credit_finalization_jobs" ADD CONSTRAINT "credit_finalization_jobs_reservation_id_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."credit_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_subject_id_account_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."account_subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_subject_id_account_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."account_subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_grant_id_credit_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."credit_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_reservation_id_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."credit_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservation_allocations" ADD CONSTRAINT "credit_reservation_allocations_reservation_id_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."credit_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservation_allocations" ADD CONSTRAINT "credit_reservation_allocations_grant_id_credit_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."credit_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_subject_id_account_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."account_subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_finalization_reservation_uq" ON "credit_finalization_jobs" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_finalization_delivery_uq" ON "credit_finalization_jobs" USING btree ("delivery_reference");--> statement-breakpoint
CREATE INDEX "credit_finalization_due_idx" ON "credit_finalization_jobs" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grant_source_uq" ON "credit_grants" USING btree ("credit_type","source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grant_idempotency_uq" ON "credit_grants" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "credit_grant_subject_type_idx" ON "credit_grants" USING btree ("subject_id","credit_type","granted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_idempotency_uq" ON "credit_ledger_entries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "credit_ledger_subject_type_idx" ON "credit_ledger_entries" USING btree ("subject_id","credit_type","created_at");--> statement-breakpoint
CREATE INDEX "credit_ledger_grant_idx" ON "credit_ledger_entries" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "credit_ledger_reservation_idx" ON "credit_ledger_entries" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "credit_allocation_grant_idx" ON "credit_reservation_allocations" USING btree ("grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_reservation_purpose_uq" ON "credit_reservations" USING btree ("subject_id","credit_type","purpose_type","purpose_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_reservation_idempotency_uq" ON "credit_reservations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "credit_reservation_subject_type_idx" ON "credit_reservations" USING btree ("subject_id","credit_type","status");--> statement-breakpoint
CREATE INDEX "credit_reservation_expiry_idx" ON "credit_reservations" USING btree ("status","expires_at");
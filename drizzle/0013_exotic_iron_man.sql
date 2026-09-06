ALTER TABLE "refunds" ADD COLUMN "provider_write_state" text DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "provider_reconciliation_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "next_provider_reconciliation_at" timestamp with time zone;--> statement-breakpoint
UPDATE "refunds"
SET "provider_write_state" = CASE
  WHEN "external_refund_reference" IS NULL THEN 'legacy_unsafe'
  ELSE 'confirmed'
END;--> statement-breakpoint
CREATE INDEX "refund_provider_reconciliation_due_idx" ON "refunds" USING btree ("provider_write_state","next_provider_reconciliation_at");--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refund_provider_write_state_valid" CHECK ("refunds"."provider_write_state" in ('not_started','dispatched','confirmed','ambiguous','legacy_unsafe'));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refund_provider_reconciliation_attempts_valid" CHECK ("refunds"."provider_reconciliation_attempts" >= 0 and "refunds"."provider_reconciliation_attempts" <= 12);

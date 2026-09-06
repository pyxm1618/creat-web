ALTER TABLE "refunds" ADD COLUMN "reconciliation_lease_owner" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "reconciliation_lease_expires_at" timestamp with time zone;
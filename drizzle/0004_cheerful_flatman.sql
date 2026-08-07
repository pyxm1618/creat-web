ALTER TYPE "public"."account_deletion_status" ADD VALUE 'dead_letter' BEFORE 'completed';--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD COLUMN "lease_token" text;--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "account_deletion_due_idx" ON "account_deletion_requests" USING btree ("status","next_attempt_at","lease_expires_at");
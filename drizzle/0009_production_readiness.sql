CREATE TABLE "credit_reconciliation_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"entity_id" text NOT NULL,
	"detail" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"first_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "credit_reconciliation_incident_status_valid" CHECK ("credit_reconciliation_incidents"."status" in ('open','resolved'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "credit_reconciliation_incident_uq" ON "credit_reconciliation_incidents" USING btree ("code","entity_id");
--> statement-breakpoint
CREATE FUNCTION "reject_credit_ledger_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'credit ledger entries are append only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "credit_ledger_entries_append_only"
BEFORE UPDATE OR DELETE ON "credit_ledger_entries"
FOR EACH ROW EXECUTE FUNCTION "reject_credit_ledger_mutation"();

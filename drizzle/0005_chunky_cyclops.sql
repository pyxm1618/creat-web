CREATE TABLE "legal_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid NOT NULL,
	"document_key" text NOT NULL,
	"version" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_subject_id_account_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."account_subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legal_acceptance_subject_document_version_uq" ON "legal_acceptances" USING btree ("subject_id","document_key","version");--> statement-breakpoint
CREATE INDEX "legal_acceptance_subject_idx" ON "legal_acceptances" USING btree ("subject_id","accepted_at");
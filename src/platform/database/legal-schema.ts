import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { accountSubjects } from "./account-subject-schema";

export const legalAcceptances = pgTable(
  "legal_acceptances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => accountSubjects.id, { onDelete: "restrict" }),
    documentKey: text("document_key").notNull(),
    version: text("version").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    source: text("source").notNull(),
  },
  (table) => [
    uniqueIndex("legal_acceptance_subject_document_version_uq").on(
      table.subjectId,
      table.documentKey,
      table.version,
    ),
    index("legal_acceptance_subject_idx").on(table.subjectId, table.acceptedAt),
  ],
);

export type LegalAcceptance = typeof legalAcceptances.$inferSelect;
export type NewLegalAcceptance = typeof legalAcceptances.$inferInsert;

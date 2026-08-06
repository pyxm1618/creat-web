import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { user } from "./auth-schema";

export const accountSubjectStatus = pgEnum("account_subject_status", [
  "active",
  "deletion_pending",
  "deleted",
]);

export const accountSubjects = pgTable("account_subjects", {
  id: uuid("id").defaultRandom().primaryKey(),
  authUserId: text("auth_user_id")
    .unique()
    .references(() => user.id, { onDelete: "set null" }),
  status: accountSubjectStatus("status").default("active").notNull(),
  pseudonymousKey: uuid("pseudonymous_key").defaultRandom().notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  deletionRequestedAt: timestamp("deletion_requested_at", {
    withTimezone: true,
    mode: "date",
  }),
  deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
});

export type AccountSubjectRow = typeof accountSubjects.$inferSelect;

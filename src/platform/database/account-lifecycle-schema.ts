import { integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { accountSubjects } from "./account-subject-schema";
import { user } from "./auth-schema";

export const accountDeletionStatus = pgEnum("account_deletion_status", [
  "pending",
  "processing",
  "failed",
  "completed",
]);

export const accountDeletionStep = pgEnum("account_deletion_step", [
  "requested",
  "access_revoked",
  "downstream_prepared",
  "identity_detached",
  "identity_deleted",
  "completed",
]);

export const accountDeletionRequests = pgTable("account_deletion_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  subjectId: uuid("subject_id")
    .notNull()
    .unique()
    .references(() => accountSubjects.id, { onDelete: "restrict" }),
  authUserId: text("auth_user_id").references(() => user.id, { onDelete: "set null" }),
  status: accountDeletionStatus("status").default("pending").notNull(),
  step: accountDeletionStep("step").default("requested").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  lastErrorCode: text("last_error_code"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
});

export const authSecurityEvents = pgTable("auth_security_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  subjectId: uuid("subject_id").references(() => accountSubjects.id, { onDelete: "set null" }),
  authUserId: text("auth_user_id"),
  eventType: text("event_type").notNull(),
  outcome: text("outcome").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

export type AccountDeletionRequestRow = typeof accountDeletionRequests.$inferSelect;

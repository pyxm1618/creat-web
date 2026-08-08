import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { accountSubjects } from "./account-subject-schema";

export const creditGrants = pgTable(
  "credit_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => accountSubjects.id, { onDelete: "restrict" }),
    creditType: text("credit_type").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    quantity: integer("quantity").notNull(),
    state: text("state").default("active").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>().default({}).notNull(),
  },
  (table) => [
    uniqueIndex("credit_grant_source_uq").on(table.creditType, table.sourceType, table.sourceId),
    uniqueIndex("credit_grant_idempotency_uq").on(table.idempotencyKey),
    index("credit_grant_subject_type_idx").on(table.subjectId, table.creditType, table.grantedAt),
    check("credit_grant_quantity_positive", sql`${table.quantity} > 0`),
    check("credit_grant_state_valid", sql`${table.state} in ('active','exhausted','expired','revoked')`),
  ],
);

export const creditReservations = pgTable(
  "credit_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => accountSubjects.id, { onDelete: "restrict" }),
    creditType: text("credit_type").notNull(),
    purposeType: text("purpose_type").notNull(),
    purposeId: text("purpose_id").notNull(),
    quantity: integer("quantity").notNull(),
    status: text("status").default("active").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    terminalCorrelationId: text("terminal_correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true, mode: "date" }),
    releasedAt: timestamp("released_at", { withTimezone: true, mode: "date" }),
    expiredAt: timestamp("expired_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("credit_reservation_purpose_uq").on(
      table.subjectId,
      table.creditType,
      table.purposeType,
      table.purposeId,
    ),
    uniqueIndex("credit_reservation_idempotency_uq").on(table.idempotencyKey),
    index("credit_reservation_subject_type_idx").on(table.subjectId, table.creditType, table.status),
    index("credit_reservation_expiry_idx").on(table.status, table.expiresAt),
    check("credit_reservation_quantity_positive", sql`${table.quantity} > 0`),
    check(
      "credit_reservation_status_valid",
      sql`${table.status} in ('active','committed','released','expired')`,
    ),
  ],
);

export const creditReservationAllocations = pgTable(
  "credit_reservation_allocations",
  {
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => creditReservations.id, { onDelete: "restrict" }),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => creditGrants.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.reservationId, table.grantId] }),
    index("credit_allocation_grant_idx").on(table.grantId),
    check("credit_allocation_quantity_positive", sql`${table.quantity} > 0`),
  ],
);

export const creditLedgerEntries = pgTable(
  "credit_ledger_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => accountSubjects.id, { onDelete: "restrict" }),
    creditType: text("credit_type").notNull(),
    grantId: uuid("grant_id").references(() => creditGrants.id, { onDelete: "restrict" }),
    reservationId: uuid("reservation_id").references(() => creditReservations.id, {
      onDelete: "restrict",
    }),
    entryType: text("entry_type").notNull(),
    quantity: integer("quantity").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    actorType: text("actor_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>().default({}).notNull(),
  },
  (table) => [
    uniqueIndex("credit_ledger_idempotency_uq").on(table.idempotencyKey),
    index("credit_ledger_subject_type_idx").on(table.subjectId, table.creditType, table.createdAt),
    index("credit_ledger_grant_idx").on(table.grantId),
    index("credit_ledger_reservation_idx").on(table.reservationId),
    check("credit_ledger_quantity_positive", sql`${table.quantity} > 0`),
    check(
      "credit_ledger_entry_type_valid",
      sql`${table.entryType} in ('grant','reserve','release','consume','expire','revoke','adjust_positive','adjust_negative')`,
    ),
  ],
);

export const creditFinalizationJobs = pgTable(
  "credit_finalization_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => creditReservations.id, { onDelete: "restrict" }),
    deliveryReference: text("delivery_reference").notNull(),
    state: text("state").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("credit_finalization_reservation_uq").on(table.reservationId),
    uniqueIndex("credit_finalization_delivery_uq").on(table.deliveryReference),
    index("credit_finalization_due_idx").on(table.state, table.nextAttemptAt),
    check(
      "credit_finalization_state_valid",
      sql`${table.state} in ('pending','processing','completed','dead_letter')`,
    ),
  ],
);

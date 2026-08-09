import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { accountSubjects } from "./account-subject-schema";
import { orders, payments } from "./commerce-schema";

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => accountSubjects.id, { onDelete: "restrict" }),
    environment: text("environment").notNull(),
    externalOrderId: text("external_order_id").notNull(),
    status: text("status").default("pending").notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true, mode: "date" }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true, mode: "date" }),
    pastDueStartedAt: timestamp("past_due_started_at", { withTimezone: true, mode: "date" }),
    pastDueGraceEndsAt: timestamp("past_due_grace_ends_at", { withTimezone: true, mode: "date" }),
    gracePolicyVersion: text("grace_policy_version"),
    providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("subscription_order_uq").on(table.orderId),
    uniqueIndex("subscription_environment_external_order_uq").on(
      table.environment,
      table.externalOrderId,
    ),
    index("subscription_subject_status_idx").on(table.subjectId, table.status, table.updatedAt),
    index("subscription_past_due_idx").on(table.status, table.pastDueGraceEndsAt),
    check("subscription_environment_valid", sql`${table.environment} in ('test','production')`),
    check(
      "subscription_status_valid",
      sql`${table.status} in ('pending','active','past_due','canceling','canceled','expired','closed')`,
    ),
    check(
      "subscription_grace_consistent",
      sql`(${table.pastDueStartedAt} is null and ${table.pastDueGraceEndsAt} is null and ${table.gracePolicyVersion} is null) or (${table.pastDueStartedAt} is not null and ${table.pastDueGraceEndsAt} is not null and ${table.gracePolicyVersion} is not null and ${table.pastDueGraceEndsAt} >= ${table.pastDueStartedAt})`,
    ),
  ],
);

export const subscriptionPeriods = pgTable(
  "subscription_periods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "restrict" }),
    paymentId: uuid("payment_id").references(() => payments.id, { onDelete: "restrict" }),
    periodStart: timestamp("period_start", { withTimezone: true, mode: "date" }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true, mode: "date" }).notNull(),
    state: text("state").default("paid").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("subscription_period_window_uq").on(
      table.subscriptionId,
      table.periodStart,
      table.periodEnd,
    ),
    index("subscription_period_payment_idx").on(table.paymentId),
    check("subscription_period_window_valid", sql`${table.periodEnd} > ${table.periodStart}`),
    check("subscription_period_state_valid", sql`${table.state} in ('paid','refunded','void')`),
  ],
);

export const refunds = pgTable(
  "refunds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "restrict" }),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => accountSubjects.id, { onDelete: "restrict" }),
    environment: text("environment").notNull(),
    externalRefundReference: text("external_refund_reference"),
    idempotencyKey: text("idempotency_key").notNull(),
    currency: text("currency").notNull(),
    requestedMinor: bigint("requested_minor", { mode: "bigint" }).notNull(),
    succeededMinor: bigint("succeeded_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    reason: text("reason").notNull(),
    status: text("status").default("pending").notNull(),
    reversalStatus: text("reversal_status").default("pending").notNull(),
    operatorReviewReason: text("operator_review_reason"),
    providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("refund_idempotency_uq").on(table.idempotencyKey),
    uniqueIndex("refund_environment_external_reference_uq")
      .on(table.environment, table.externalRefundReference)
      .where(sql`${table.externalRefundReference} is not null`),
    index("refund_payment_idx").on(table.paymentId, table.createdAt),
    index("refund_operator_review_idx").on(table.status, table.reversalStatus),
    check("refund_environment_valid", sql`${table.environment} in ('test','production')`),
    check("refund_requested_minor_positive", sql`${table.requestedMinor} > 0`),
    check(
      "refund_succeeded_minor_valid",
      sql`${table.succeededMinor} >= 0 and ${table.succeededMinor} <= ${table.requestedMinor}`,
    ),
    check(
      "refund_status_valid",
      sql`${table.status} in ('pending','processing','succeeded','failed','reconciliation_required')`,
    ),
    check(
      "refund_reversal_status_valid",
      sql`${table.reversalStatus} in ('pending','completed','not_required','reconciliation_required')`,
    ),
  ],
);

export const commerceCommandJobs = pgTable(
  "commerce_command_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => accountSubjects.id, { onDelete: "restrict" }),
    commandType: text("command_type").notNull(),
    targetId: uuid("target_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().default({}).notNull(),
    state: text("state").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("commerce_command_idempotency_uq").on(table.idempotencyKey),
    index("commerce_command_due_idx").on(table.state, table.nextAttemptAt),
    check(
      "commerce_command_type_valid",
      sql`${table.commandType} in ('subscription_cancel','subscription_resume','refund_request')`,
    ),
    check(
      "commerce_command_state_valid",
      sql`${table.state} in ('pending','processing','completed','dead_letter')`,
    ),
  ],
);

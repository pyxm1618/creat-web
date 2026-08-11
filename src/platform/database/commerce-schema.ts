import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
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

const bytea = customType<{ data: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

export const commerceProducts = pgTable(
  "commerce_products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: text("key").notNull(),
    version: integer("version").notNull(),
    model: text("model").notNull(),
    billingInterval: text("billing_interval"),
    environment: text("environment").notNull(),
    providerProductId: text("provider_product_id").notNull(),
    currency: text("currency").notNull(),
    expectedMinor: bigint("expected_minor", { mode: "bigint" }).notNull(),
    fulfillmentKey: text("fulfillment_key").notNull(),
    refundPolicyKey: text("refund_policy_key").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    activeFrom: timestamp("active_from", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    activeTo: timestamp("active_to", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("commerce_product_key_version_environment_uq").on(
      table.key,
      table.version,
      table.environment,
    ),
    check("commerce_product_expected_minor_positive", sql`${table.expectedMinor} > 0`),
    check("commerce_product_environment_valid", sql`${table.environment} in ('test','production')`),
    check("commerce_product_model_valid", sql`${table.model} in ('one_time','subscription')`),
    check(
      "commerce_product_billing_interval_valid",
      sql`(${table.model} = 'one_time' and ${table.billingInterval} is null) or (${table.model} = 'subscription' and ${table.billingInterval} in ('month','year'))`,
    ),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => accountSubjects.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => commerceProducts.id, { onDelete: "restrict" }),
    environment: text("environment").notNull(),
    status: text("status").default("pending").notNull(),
    expectedCurrency: text("expected_currency").notNull(),
    expectedMinor: bigint("expected_minor", { mode: "bigint" }).notNull(),
    checkoutIdempotencyKey: text("checkout_idempotency_key").notNull(),
    checkoutState: text("checkout_state").default("creating").notNull(),
    checkoutLeaseToken: text("checkout_lease_token"),
    checkoutLeaseExpiresAt: timestamp("checkout_lease_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    externalCheckoutSessionId: text("external_checkout_session_id"),
    externalOrderId: text("external_order_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
    canceledAt: timestamp("canceled_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("order_checkout_idempotency_uq").on(table.checkoutIdempotencyKey),
    uniqueIndex("order_environment_external_order_uq")
      .on(table.environment, table.externalOrderId)
      .where(sql`${table.externalOrderId} is not null`),
    index("order_subject_created_idx").on(table.subjectId, table.createdAt),
    check("order_expected_minor_positive", sql`${table.expectedMinor} > 0`),
    check("order_environment_valid", sql`${table.environment} in ('test','production')`),
    check(
      "order_status_valid",
      sql`${table.status} in ('pending','paid','canceled','partially_refunded','refunded')`,
    ),
    check(
      "order_checkout_state_valid",
      sql`${table.checkoutState} in ('creating','created','failed')`,
    ),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    environment: text("environment").notNull(),
    externalPaymentId: text("external_payment_id").notNull(),
    status: text("status").notNull(),
    refundStatus: text("refund_status").default("none").notNull(),
    currency: text("currency").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    refundedMinor: bigint("refunded_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    providerCreatedAt: timestamp("provider_created_at", { withTimezone: true, mode: "date" }),
    rawPayloadHash: text("raw_payload_hash").notNull(),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("payment_environment_external_payment_uq").on(
      table.environment,
      table.externalPaymentId,
    ),
    index("payment_order_idx").on(table.orderId),
    check("payment_amount_nonnegative", sql`${table.amountMinor} >= 0`),
    check(
      "payment_refunded_minor_valid",
      sql`${table.refundedMinor} >= 0 and ${table.refundedMinor} <= ${table.amountMinor}`,
    ),
    check("payment_environment_valid", sql`${table.environment} in ('test','production')`),
    check(
      "payment_status_valid",
      sql`${table.status} in ('pending','succeeded','failed','canceled')`,
    ),
    check(
      "payment_refund_status_valid",
      sql`${table.refundStatus} in ('none','partial','refunded','failed')`,
    ),
  ],
);

export const paymentWebhookInbox = pgTable(
  "payment_webhook_inbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    environment: text("environment").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    dedupHash: text("dedup_hash").notNull(),
    eventType: text("event_type").notNull(),
    signatureValid: boolean("signature_valid").notNull(),
    normalizedPayloadJson: jsonb("normalized_payload_json")
      .$type<Record<string, unknown>>()
      .notNull(),
    payloadHash: text("payload_hash").notNull(),
    payloadSizeBytes: integer("payload_size_bytes").notNull(),
    rawPayloadCiphertext: bytea("raw_payload_ciphertext"),
    rawPayloadKeyId: text("raw_payload_key_id"),
    rawPayloadExpiresAt: timestamp("raw_payload_expires_at", { withTimezone: true, mode: "date" }),
    rawPayloadPurgedAt: timestamp("raw_payload_purged_at", { withTimezone: true, mode: "date" }),
    retentionClass: text("retention_class").notNull(),
    legalHoldReviewAt: timestamp("legal_hold_review_at", { withTimezone: true, mode: "date" }),
    state: text("state").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    lastErrorCode: text("last_error_code"),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("webhook_environment_event_uq").on(table.environment, table.providerEventId),
    uniqueIndex("webhook_environment_dedup_uq").on(table.environment, table.dedupHash),
    index("webhook_due_idx").on(table.state, table.nextAttemptAt),
    check("webhook_environment_valid", sql`${table.environment} in ('test','production')`),
    check("webhook_payload_size_nonnegative", sql`${table.payloadSizeBytes} >= 0`),
    check(
      "webhook_retention_class_valid",
      sql`${table.retentionClass} in ('normalized_only','transient_encrypted','unresolved_encrypted','invalid_signature')`,
    ),
    check(
      "webhook_invalid_signature_no_raw",
      sql`${table.signatureValid} or (${table.rawPayloadCiphertext} is null and ${table.rawPayloadKeyId} is null and ${table.rawPayloadExpiresAt} is null)`,
    ),
  ],
);

export const fulfillmentJobs = pgTable(
  "fulfillment_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
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
    uniqueIndex("fulfillment_idempotency_uq").on(table.idempotencyKey),
    index("fulfillment_due_idx").on(table.state, table.nextAttemptAt),
    check(
      "fulfillment_state_valid",
      sql`${table.state} in ('pending','processing','completed','dead_letter')`,
    ),
  ],
);

export const paymentReconciliationJobs = pgTable(
  "payment_reconciliation_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    state: text("state").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    lastErrorCode: text("last_error_code"),
    operatorReviewReason: text("operator_review_reason"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("payment_reconciliation_order_uq").on(table.orderId),
    index("payment_reconciliation_due_idx").on(table.state, table.nextAttemptAt, table.createdAt),
    index("payment_reconciliation_reclaim_idx").on(table.state, table.leaseExpiresAt),
    check(
      "payment_reconciliation_job_state_valid",
      sql`${table.state} in ('pending','processing','completed','operator_review','dead_letter')`,
    ),
    check(
      "payment_reconciliation_job_attempts_valid",
      sql`${table.attempts} >= 0 and ${table.attempts} <= 12 and ((${table.state} = 'dead_letter' and ${table.attempts} = 12) or (${table.state} <> 'dead_letter' and ${table.attempts} < 12))`,
    ),
    check(
      "payment_reconciliation_job_lease_consistent",
      sql`(${table.state} = 'processing' and ${table.leaseOwner} is not null and ${table.leaseToken} is not null and ${table.leaseExpiresAt} is not null) or (${table.state} <> 'processing' and ${table.leaseOwner} is null and ${table.leaseToken} is null and ${table.leaseExpiresAt} is null)`,
    ),
    check(
      "payment_reconciliation_job_review_reason_consistent",
      sql`(${table.state} = 'operator_review' and ${table.operatorReviewReason} is not null) or (${table.state} <> 'operator_review' and ${table.operatorReviewReason} is null)`,
    ),
    check(
      "payment_reconciliation_job_terminal_time_consistent",
      sql`(${table.state} in ('completed','operator_review','dead_letter') and ${table.completedAt} is not null) or (${table.state} in ('pending','processing') and ${table.completedAt} is null)`,
    ),
  ],
);

export const commerceReconciliationRuns = pgTable(
  "commerce_reconciliation_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    dedupKey: text("dedup_key"),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    actorType: text("actor_type").notNull(),
    beforeJson: jsonb("before_json").$type<Record<string, unknown>>().notNull(),
    afterJson: jsonb("after_json").$type<Record<string, unknown>>().notNull(),
    result: text("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_reconciliation_run_dedup_uq")
      .on(table.dedupKey)
      .where(sql`${table.dedupKey} is not null`),
  ],
);

import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const commerceAppliedEvents = pgTable(
  "commerce_applied_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    environment: text("environment").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadHash: text("payload_hash").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("commerce_applied_event_environment_provider_uq").on(
      table.environment,
      table.providerEventId,
    ),
  ],
);

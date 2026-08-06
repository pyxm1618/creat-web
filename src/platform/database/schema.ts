import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const platformMeta = pgTable("platform_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull(),
});

export type PlatformMeta = typeof platformMeta.$inferSelect;
export type NewPlatformMeta = typeof platformMeta.$inferInsert;

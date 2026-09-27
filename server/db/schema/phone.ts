import { pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const phoneLinks = pgTable("pat_phone_links", {
  appUserId: text("app_user_id").notNull(),
  phoneNumber: text("phone_number").notNull(),
  linkedAt: timestamp("linked_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.phoneNumber] }),
  uniqueIndex("pat_phone_links_app_user_idx").on(table.appUserId),
]).enableRLS();

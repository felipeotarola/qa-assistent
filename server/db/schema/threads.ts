import { relations } from "drizzle-orm";
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { workspaces } from "./workspaces";

export const threads = pgTable("pat_threads", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  workspaceId: text("workspace_id").references(() => workspaces.id),
  /** The eve session this thread talks to. eve holds the transcript. */
  sessionId: text("session_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
}, (table) => [
  index("pat_threads_user_updated_idx").on(table.userId, table.updatedAt),
]).enableRLS();

export const threadsRelations = relations(threads, ({ one }) => ({
  user: one(user, {
    fields: [threads.userId],
    references: [user.id],
  }),
}));

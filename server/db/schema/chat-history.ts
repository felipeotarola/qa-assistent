import { pgTable, text, jsonb, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
import { threads } from "./threads";
import type { MessageStreamEvent } from "eve/client";

export const chatRuntimes = pgTable("pat_chat_runtimes", {
  threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  runtime: text("runtime").notNull(),
  sessionId: text("session_id"),
}, t => [primaryKey({ columns: [t.threadId, t.runtime] })]).enableRLS();
export const chatEvents = pgTable("pat_chat_events", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  event: jsonb("event").$type<MessageStreamEvent>().notNull(),
  emittedAt: timestamp("emitted_at").notNull(),
}, t => [index("pat_chat_events_thread_idx").on(t.threadId, t.emittedAt)]).enableRLS();

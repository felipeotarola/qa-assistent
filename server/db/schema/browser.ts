import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { threads } from "./threads";
import { user } from "./auth";

// No browser credentials or live URLs are exposed through normal thread APIs.
export const browserSessions = pgTable("pat_browser_sessions", {
  threadId: text("thread_id").primaryKey().references(() => threads.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  contextId: text("context_id"),
  sessionId: text("session_id"),
  projectId: text("project_id"),
  connectUrl: text("connect_url"),
  liveUrl: text("live_url"),
  control: text("control").notNull().default("agent"),
  url: text("url").notNull().default(""),
  title: text("title").notNull().default(""),
  expiresAt: timestamp("expires_at"),
  activeAt: timestamp("active_at").notNull().defaultNow(),
}).enableRLS();

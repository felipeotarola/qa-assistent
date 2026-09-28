import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { workspaceItems, workspaces } from "./workspaces";
import { threads } from "./threads";
export const workspaceEvidence = pgTable("pat_workspace_evidence", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  itemId: text("item_id").notNull().references(() => workspaceItems.id, { onDelete: "cascade" }),
  itemVersion: integer("item_version").notNull(),
  kind: text("kind").notNull(), label: text("label").notNull(), url: text("url"),
  targetItemId: text("target_item_id").references(() => workspaceItems.id, { onDelete: "set null" }),
  targetVersion: integer("target_version"),
  threadId: text("thread_id").references(() => threads.id, { onDelete: "set null" }),
  observedAt: timestamp("observed_at"), createdAt: timestamp("created_at").notNull().defaultNow(),
}, t => [index("pat_workspace_evidence_item_idx").on(t.itemId)]).enableRLS();

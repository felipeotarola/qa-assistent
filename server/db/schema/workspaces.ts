import { pgTable, text, timestamp, jsonb, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth";
import type { ItemContent } from "../../../shared/workspace";

export const workspaces = pgTable("pat_workspaces", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  cardOrder: jsonb("card_order").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}).enableRLS();
export const workspaceItems = pgTable("pat_workspace_items", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  content: jsonb("content").$type<ItemContent>().notNull(),
  blobPath: text("blob_path"),
  deletedAt: timestamp("deleted_at"),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}).enableRLS();
export const workspaceItemVersions = pgTable("pat_workspace_item_versions", {
  id: text("id").primaryKey(),
  itemId: text("item_id").notNull().references(() => workspaceItems.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  title: text("title").notNull(),
  content: jsonb("content").$type<ItemContent>().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, t => [uniqueIndex("pat_item_version_idx").on(t.itemId, t.version)]).enableRLS();
export const workspaceBrowsers = pgTable("pat_workspace_browsers", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  contextId: text("context_id"), sessionId: text("session_id"), projectId: text("project_id"), connectUrl: text("connect_url"), liveUrl: text("live_url"),
  control: text("control").notNull().default("agent"), url: text("url").notNull().default(""), title: text("title").notNull().default(""),
  expiresAt: timestamp("expires_at"), activeAt: timestamp("active_at").notNull().defaultNow(),
}).enableRLS();

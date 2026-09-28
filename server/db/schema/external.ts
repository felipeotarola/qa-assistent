import { pgTable, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";
import type { Destination, ExternalIssue } from "../../../shared/external";

export const workspaceDestinations = pgTable("pat_workspace_destinations", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  destination: jsonb("destination").$type<Destination>().notNull(),
}, t => [uniqueIndex("pat_workspace_destination_idx").on(t.workspaceId, t.provider)]).enableRLS();

// A committed pending receipt precedes the network write. Interrupted calls
// never blindly repeat a remote mutation whose outcome may be unknown.
export const externalOperations = pgTable("pat_external_operations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  action: text("action").notNull(),
  fingerprint: text("fingerprint").notNull(),
  destination: jsonb("destination").$type<Destination>().notNull(),
  state: text("state").notNull().default("pending"),
  result: jsonb("result").$type<ExternalIssue>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}).enableRLS();

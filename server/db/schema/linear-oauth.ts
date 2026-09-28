import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";

export const linearAccounts = pgTable("pat_linear_accounts", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  credentials: text("credentials").notNull(),
  label: text("label").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
}).enableRLS();
export const linearOauthStates = pgTable("pat_linear_oauth_states", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  verifier: text("verifier").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  returnUrl: text("return_url").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
}).enableRLS();

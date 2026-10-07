import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Shared by app and Eve, across workspaces/runtimes using the same credential
// and model. Contains no API key, prompt, principal, or provider output.
export const providerPacing = pgTable('pat_provider_pacing', {
  bucketHash: text('bucket_hash').primaryKey(),
  nextStartAt: timestamp('next_start_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
}).enableRLS();

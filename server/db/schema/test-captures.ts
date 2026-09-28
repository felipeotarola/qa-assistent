import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { testRuns } from './test-runs';
import { workspaceItems } from './workspaces';
export const testCaptures = pgTable('pat_test_captures', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => testRuns.id, { onDelete: 'cascade' }),
  itemId: text('item_id').references(() => workspaceItems.id, { onDelete: 'restrict' }),
  url: text('url').notNull(), title: text('title').notNull(), action: text('action').notNull(),
  error: text('error'), createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [index('pat_test_capture_run_idx').on(t.runId, t.createdAt)]).enableRLS();

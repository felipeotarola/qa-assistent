import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { threads } from './threads';
export const browserJobs = pgTable('pat_browser_jobs', {
  id: text('id').primaryKey(),
  threadId: text('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
  runtime: text('runtime').notNull(),
  parentSessionId: text('parent_session_id').notNull(),
  sessionId: text('session_id'),
  dispatchLeaseToken: text('dispatch_lease_token'),
  dispatchLeaseUntil: timestamp('dispatch_lease_until', { withTimezone: true }),
  task: text('task').notNull(),
  status: text('status').notNull().default('starting'),
  report: text('report').notNull().default(''),
  model: text('model').notNull(),
  reasoning: text('reasoning').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, t => [index('pat_browser_jobs_thread_idx').on(t.threadId)]).enableRLS();

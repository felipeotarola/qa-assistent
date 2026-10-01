import { pgTable, text, timestamp, jsonb, integer, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { testRuns } from './test-runs';
import { workspaces } from './workspaces';
import type { Assessment, ReviewInput } from '../../../shared/result-assessment';

export const resultAssessments = pgTable('pat_result_assessments', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => testRuns.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(), threadId: text('thread_id').notNull(), runtime: text('runtime').notNull(),
  reviewerVersion: text('reviewer_version').notNull(), model: text('model').notNull(),
  sourceHash: text('source_hash').notNull(), inputHash: text('input_hash').notNull(), input: jsonb('input').$type<ReviewInput>().notNull(),
  status: text('status').$type<'queued' | 'running' | 'completed' | 'failed'>().notNull().default('queued'),
  assessment: jsonb('assessment').$type<Assessment>(), error: text('error'), attempts: integer('attempts').notNull().default(0),
  leaseToken: text('lease_token'), leaseUntil: timestamp('lease_until'), nextAttemptAt: timestamp('next_attempt_at').notNull().defaultNow(),
  notification: text('notification').notNull().default('pending'),
  createdAt: timestamp('created_at').notNull().defaultNow(), finishedAt: timestamp('finished_at'),
}, t => [uniqueIndex('pat_result_assessment_input_idx').on(t.runId, t.runtime, t.sourceHash, t.reviewerVersion), index('pat_result_assessment_queue_idx').on(t.runtime, t.status, t.nextAttemptAt)]).enableRLS();

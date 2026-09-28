import { pgTable, text, timestamp, jsonb, integer, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { workspaces, workspaceItems } from './workspaces';
import { testRuns } from './test-runs';
import type { ExternalIssue, Destination } from '../../../shared/external';

export const testRequirements = pgTable('pat_test_requirements', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  itemId: text('item_id').notNull().references(() => workspaceItems.id, { onDelete: 'cascade' }),
  caseId: text('case_id').notNull(), userId: text('user_id').notNull(), requestId: text('request_id').notNull(),
  question: text('question').notNull(), clarification: text('clarification').notNull(), expected: text('expected').notNull(),
  requestedIssueId: text('requested_issue_id'),
  planVersion: integer('plan_version').notNull(),
  sourceItemId: text('source_item_id'), sourceVersion: integer('source_version'),
  issue: jsonb('issue').$type<ExternalIssue>(), destination: jsonb('destination').$type<Destination>(),
  preparedBody: text('prepared_body'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  publishedAt: timestamp('published_at'), appliedVersion: integer('applied_version'), materialId: text('material_id'),
}, t => [uniqueIndex('pat_requirement_request_idx').on(t.workspaceId, t.requestId), index('pat_requirement_case_idx').on(t.itemId, t.caseId, t.createdAt)]).enableRLS();

export const testRunReviews = pgTable('pat_test_run_reviews', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => testRuns.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(), requestId: text('request_id').notNull(),
  outcome: text('outcome').$type<'passed' | 'failed' | 'inconclusive'>().notNull(), reason: text('reason').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [uniqueIndex('pat_run_review_request_idx').on(t.runId, t.requestId), index('pat_run_review_idx').on(t.runId, t.createdAt)]).enableRLS();

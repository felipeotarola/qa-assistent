import { pgTable, text, timestamp, jsonb, integer, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { workspaceItems, workspaces } from './workspaces';
import type { TestCase } from '../../../shared/test-plan';
import type { RunResult } from '../../../shared/test-run';
import type { TestTarget } from '../../../shared/quality';
import { missionAttempts } from './missions';

/** Private executor state, never accepted from model input or exposed as proof. */
export type BrowserEntryReceipt = { version: 1; sessionId: string; requestedUrl: string; observedUrl: string | null; observedAt: string; callId: string };

export const testRuns = pgTable('pat_test_runs', {
  runtime: text('runtime'),
  // Immutable execution owner. Never infer this from reusable report attachments.
  missionAttemptId: text('mission_attempt_id').references(() => missionAttempts.id),
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  itemId: text('item_id').notNull().references(() => workspaceItems.id, { onDelete: 'cascade' }),
  caseId: text('case_id').notNull(),
  planVersion: integer('plan_version').notNull(),
  snapshot: jsonb('snapshot').$type<TestCase>().notNull(),
  browserEntryReceipt: jsonb('browser_entry_receipt').$type<BrowserEntryReceipt>(),
  environment: text('environment').notNull(),
  target: jsonb('target').$type<TestTarget>(),
  threadId: text('thread_id').notNull(),
  requestId: text('request_id').notNull(),
  result: jsonb('result').$type<RunResult>(),
  startedAt: timestamp('started_at').notNull().defaultNow(),
  finishedAt: timestamp('finished_at'),
}, t => [uniqueIndex('pat_run_request_idx').on(t.workspaceId, t.requestId), index('pat_run_case_idx').on(t.itemId, t.caseId, t.startedAt)]).enableRLS();

import { pgTable, text, integer, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { workspaces, workspaceItems } from './workspaces';
import type { MissionConfig, MissionSnapshot, WorkResult } from '../../../shared/mission';
import type { ReportDocument } from '../../../shared/mission-report';

export const missions = pgTable('pat_missions', {
  reconciledAt: timestamp('reconciled_at').notNull().defaultNow(),
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), userId: text('user_id').notNull(), threadId: text('thread_id').notNull(), runtime: text('runtime').notNull(), requestId: text('request_id').notNull(),
  config: jsonb('config').$type<MissionConfig>().notNull(), status: text('status').notNull().default('active'), revision: integer('revision').notNull().default(1),
  dirtySince: timestamp('dirty_since').defaultNow(), updatedAt: timestamp('updated_at').notNull().defaultNow(), createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [uniqueIndex('pat_mission_request').on(t.workspaceId, t.runtime, t.requestId)]).enableRLS();
export const missionTasks = pgTable('pat_mission_tasks', {
  id: text('id').primaryKey(), missionId: text('mission_id').notNull().references(() => missions.id, { onDelete: 'cascade' }), requestId: text('request_id').notNull(), title: text('title').notNull(), actor: text('actor').notNull(), parentId: text('parent_id'), criterionIds: jsonb('criterion_ids').$type<string[]>().notNull(), dependsOn: jsonb('depends_on').$type<string[]>().notNull(),
  sources: jsonb('sources').$type<{ type: WorkResult['sourceType']; id: string }[]>().notNull().default([]), results: jsonb('results').$type<WorkResult[]>().notNull().default([]), createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [uniqueIndex('pat_mission_task_request').on(t.missionId, t.requestId)]).enableRLS();
export const missionEvents = pgTable('pat_mission_events', {
  id: text('id').primaryKey(), missionId: text('mission_id').notNull().references(() => missions.id, { onDelete: 'cascade' }), revision: integer('revision').notNull(), kind: text('kind').notNull(), payload: jsonb('payload').$type<Record<string, unknown>>().notNull(), createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [uniqueIndex('pat_mission_event_revision').on(t.missionId, t.revision)]).enableRLS();
export const missionSnapshots = pgTable('pat_mission_snapshots', {
  id: text('id').primaryKey(), missionId: text('mission_id').notNull().references(() => missions.id, { onDelete: 'cascade' }), revision: integer('revision').notNull(), hash: text('hash').notNull(), input: jsonb('input').$type<MissionSnapshot>().notNull(), createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [uniqueIndex('pat_mission_snapshot_revision').on(t.missionId, t.revision)]).enableRLS();
export const missionReports = pgTable('pat_mission_reports', {
  usage: jsonb('usage').$type<{ inputTokens: number; outputTokens: number; totalTokens: number; steps: number; durationMs: number; queueMs: number }>(),
  readReceipts: jsonb('read_receipts').$type<{ id: string; version: number | null; hash: string; digest: string; limited: boolean; readAt: string }[]>().notNull().default([]),
  id: text('id').primaryKey(), missionId: text('mission_id').notNull().references(() => missions.id, { onDelete: 'cascade' }), snapshotId: text('snapshot_id').notNull().references(() => missionSnapshots.id, { onDelete: 'cascade' }), version: text('version').notNull(),
  status: text('status').notNull().default('queued'), phase: text('phase').notNull().default('Sammanställer underlag'), attempts: integer('attempts').notNull().default(0), leaseToken: text('lease_token'), leaseUntil: timestamp('lease_until'), nextAttemptAt: timestamp('next_attempt_at').notNull().defaultNow(),
  error: text('error'), model: text('model'), document: jsonb('document').$type<ReportDocument>(), readIds: jsonb('read_ids').$type<string[]>().notNull().default([]), itemId: text('item_id').references(() => workspaceItems.id, { onDelete: 'set null' }), notification: text('notification').notNull().default('pending'), finishedAt: timestamp('finished_at'), createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [uniqueIndex('pat_mission_report_snapshot').on(t.snapshotId, t.version), index('pat_mission_report_queue').on(t.status, t.nextAttemptAt)]).enableRLS();

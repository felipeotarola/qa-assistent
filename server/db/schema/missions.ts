import { pgTable, text, integer, jsonb, timestamp, uniqueIndex, index, foreignKey } from 'drizzle-orm/pg-core';
import { workspaces, workspaceItems } from './workspaces';
import type { MissionConfig, MissionSnapshot, WorkResult } from '../../../shared/mission';
import type { ReportDocument } from '../../../shared/mission-report';
import type { DispatchReceipt, MissionAdmission, MissionAttemptState, MissionAttemptUsage, MissionClosureReason, MissionDependencyRequirement, MissionLifecycle, MissionMandate, MissionPhase, MissionTaskKind, MissionTaskSpec, MissionTaskState, MissionWait, MissionWaitAnswer } from '../../../shared/mission-control';

export const missions = pgTable('pat_missions', {
  // Null is historical/manual work, never an invitation to adopt it into the controller.
  controllerVersion: integer('controller_version'), admission: jsonb('admission').$type<MissionAdmission>(), requestHash: text('request_hash'),
  intent: text('intent').$type<MissionAdmission['intent']>(), mandate: jsonb('mandate').$type<MissionMandate>(),
  planRevision: integer('plan_revision'), mandateRevision: integer('mandate_revision'),
  lifecycle: text('lifecycle').$type<MissionLifecycle>(), phase: text('phase').$type<MissionPhase>(), closureReason: text('closure_reason').$type<MissionClosureReason>(),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }), reportDeadlineAt: timestamp('report_deadline_at', { withTimezone: true }), closedAt: timestamp('closed_at', { withTimezone: true }),
  leaseToken: text('lease_token'), leaseUntil: timestamp('lease_until', { withTimezone: true }), fence: integer('fence'),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }), nextWakeAt: timestamp('next_wake_at', { withTimezone: true }),
  reconciledAt: timestamp('reconciled_at').notNull().defaultNow(),
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), userId: text('user_id').notNull(), threadId: text('thread_id').notNull(), runtime: text('runtime').notNull(), requestId: text('request_id').notNull(),
  config: jsonb('config').$type<MissionConfig>().notNull(), status: text('status').notNull().default('active'), revision: integer('revision').notNull().default(1),
  dirtySince: timestamp('dirty_since').defaultNow(), updatedAt: timestamp('updated_at').notNull().defaultNow(), createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [uniqueIndex('pat_mission_request').on(t.workspaceId, t.runtime, t.requestId), index('pat_mission_control_queue').on(t.runtime, t.controllerVersion, t.lifecycle, t.nextWakeAt)]).enableRLS();
export const missionTasks = pgTable('pat_mission_tasks', {
  spec: jsonb('spec').$type<MissionTaskSpec>(), state: text('state').$type<MissionTaskState>(), operationId: text('operation_id'),
  dependencyRequirements: jsonb('dependency_requirements').$type<MissionDependencyRequirement[]>(),
  supplementRound: integer('supplement_round'), blockedReason: text('blocked_reason'), planRevision: integer('plan_revision'),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  id: text('id').primaryKey(), missionId: text('mission_id').notNull().references(() => missions.id, { onDelete: 'cascade' }), requestId: text('request_id').notNull(), title: text('title').notNull(), actor: text('actor').notNull(), parentId: text('parent_id'), criterionIds: jsonb('criterion_ids').$type<string[]>().notNull(), dependsOn: jsonb('depends_on').$type<string[]>().notNull(),
  sources: jsonb('sources').$type<{ type: WorkResult['sourceType']; id: string }[]>().notNull().default([]), results: jsonb('results').$type<WorkResult[]>().notNull().default([]), createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [uniqueIndex('pat_mission_task_request').on(t.missionId, t.requestId), uniqueIndex('pat_mission_task_identity').on(t.missionId, t.id), uniqueIndex('pat_mission_task_operation').on(t.missionId, t.operationId)]).enableRLS();
export const missionEvents = pgTable('pat_mission_events', {
  eventKey: text('event_key'),
  id: text('id').primaryKey(), missionId: text('mission_id').notNull().references(() => missions.id, { onDelete: 'cascade' }), revision: integer('revision').notNull(), kind: text('kind').notNull(), payload: jsonb('payload').$type<Record<string, unknown>>().notNull(), createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [uniqueIndex('pat_mission_event_revision').on(t.missionId, t.revision), uniqueIndex('pat_mission_event_key').on(t.missionId, t.eventKey)]).enableRLS();

export const missionAttempts = pgTable('pat_mission_attempts', {
  id: text('id').primaryKey(), missionId: text('mission_id').notNull().references(() => missions.id, { onDelete: 'cascade' }),
  taskId: text('task_id').notNull(), runtime: text('runtime').notNull(),
  kind: text('kind').$type<MissionTaskKind>().notNull(),
  operationId: text('operation_id').notNull(), requestHash: text('request_hash').notNull(), dispatchId: text('dispatch_id').notNull(),
  attemptNo: integer('attempt_no').notNull(), supplementRound: integer('supplement_round').notNull().default(0),
  mandateRevision: integer('mandate_revision').notNull(), planRevision: integer('plan_revision').notNull(),
  status: text('status').$type<MissionAttemptState>().notNull().default('reserved'),
  reservedTokens: integer('reserved_tokens').notNull(), reservedToolCalls: integer('reserved_tool_calls').notNull(),
  toolCalls: integer('tool_calls').notNull().default(0), toolCallIds: jsonb('tool_call_ids').$type<string[]>().notNull().default([]),
  usage: jsonb('usage').$type<MissionAttemptUsage>(), receipt: jsonb('receipt').$type<DispatchReceipt>(),
  executorResourceId: text('executor_resource_id'), error: text('error'), cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
  leaseToken: text('lease_token'), leaseUntil: timestamp('lease_until', { withTimezone: true }), fence: integer('fence').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(), finishedAt: timestamp('finished_at', { withTimezone: true }),
}, t => [
  foreignKey({ name: 'pat_mission_attempt_task_fk', columns: [t.missionId, t.taskId], foreignColumns: [missionTasks.missionId, missionTasks.id] }).onDelete('cascade'),
  uniqueIndex('pat_mission_attempt_dispatch').on(t.dispatchId),
  uniqueIndex('pat_mission_attempt_operation').on(t.missionId, t.operationId, t.attemptNo),
  index('pat_mission_attempt_active').on(t.runtime, t.status, t.deadlineAt),
]).enableRLS();

export const missionWaits = pgTable('pat_mission_waits', {
  id: text('id').primaryKey(), missionId: text('mission_id').notNull().references(() => missions.id, { onDelete: 'cascade' }),
  waitKey: text('wait_key').notNull(), definition: jsonb('definition').$type<MissionWait>().notNull(),
  state: text('state').$type<'waiting' | 'answered' | 'expired' | 'cancelled'>().notNull().default('waiting'),
  answer: jsonb('answer').$type<MissionWaitAnswer>(), answerRequestId: text('answer_request_id'),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(), answeredAt: timestamp('answered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('pat_mission_wait_identity').on(t.missionId, t.waitKey), index('pat_mission_wait_deadline').on(t.state, t.deadlineAt)]).enableRLS();

export const missionResourceClaims = pgTable('pat_mission_resource_claims', {
  id: text('id').primaryKey(), poolKey: text('pool_key').notNull(), resourceKey: text('resource_key').notNull(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  missionId: text('mission_id').notNull().references(() => missions.id, { onDelete: 'cascade' }),
  attemptId: text('attempt_id').notNull().references(() => missionAttempts.id, { onDelete: 'cascade' }), runtime: text('runtime').notNull(),
  owner: text('owner').$type<'agent' | 'human'>().notNull().default('agent'),
  state: text('state').$type<'claimed' | 'releasing' | 'uncertain'>().notNull().default('claimed'),
  executorResourceId: text('executor_resource_id'), leaseToken: text('lease_token').notNull(), fence: integer('fence').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  // Runtime/tenant are deliberately absent: one physical Otto pool remains exclusive.
  uniqueIndex('pat_mission_resource_exclusive').on(t.poolKey, t.resourceKey),
  index('pat_mission_resource_attempt').on(t.attemptId),
]).enableRLS();
export const missionSnapshots = pgTable('pat_mission_snapshots', {
  id: text('id').primaryKey(), missionId: text('mission_id').notNull().references(() => missions.id, { onDelete: 'cascade' }), revision: integer('revision').notNull(), hash: text('hash').notNull(), input: jsonb('input').$type<MissionSnapshot>().notNull(), createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [uniqueIndex('pat_mission_snapshot_revision').on(t.missionId, t.revision)]).enableRLS();
export const missionReports = pgTable('pat_mission_reports', {
  usage: jsonb('usage').$type<{ inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; steps: number; durationMs: number; queueMs: number }>(),
  readReceipts: jsonb('read_receipts').$type<{ id: string; version: number | null; hash: string; digest: string; limited: boolean; readAt: string }[]>().notNull().default([]),
  id: text('id').primaryKey(), missionId: text('mission_id').notNull().references(() => missions.id, { onDelete: 'cascade' }), snapshotId: text('snapshot_id').notNull().references(() => missionSnapshots.id, { onDelete: 'cascade' }), version: text('version').notNull(),
  status: text('status').notNull().default('queued'), phase: text('phase').notNull().default('Sammanställer underlag'), attempts: integer('attempts').notNull().default(0), leaseToken: text('lease_token'), leaseUntil: timestamp('lease_until'), nextAttemptAt: timestamp('next_attempt_at').notNull().defaultNow(),
  error: text('error'), model: text('model'), document: jsonb('document').$type<ReportDocument>(), readIds: jsonb('read_ids').$type<string[]>().notNull().default([]), itemId: text('item_id').references(() => workspaceItems.id, { onDelete: 'set null' }), notification: text('notification').notNull().default('pending'), finishedAt: timestamp('finished_at'), createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [uniqueIndex('pat_mission_report_snapshot').on(t.snapshotId, t.version), index('pat_mission_report_queue').on(t.status, t.nextAttemptAt)]).enableRLS();

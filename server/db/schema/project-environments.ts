import { pgTable, text, jsonb, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { threads } from './threads';
import type { AutonomousSetup, SetupResult } from '../../../shared/project-environment';

export const setupJobs = pgTable('pat_setup_jobs', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  threadId: text('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
  runtime: text('runtime').notNull(), parentSessionId: text('parent_session_id').notNull(), sessionKey: text('session_key').notNull(),
  task: text('task').notNull(), model: text('model').notNull(), reasoning: text('reasoning').notNull(),
  status: text('status').notNull().default('starting'), result: jsonb('result').$type<SetupResult>(),
  autonomy: jsonb('autonomy').$type<AutonomousSetup>(),
  notification: text('notification').notNull().default('pending'), notifiedVersion: text('notified_version'),
  applyRevision: integer('apply_revision'), updatedAt: timestamp('updated_at').defaultNow().notNull(), createdAt: timestamp('created_at').defaultNow().notNull(),
}).enableRLS();
export const projectEnvironments = pgTable('pat_project_environments', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  repoUrl: text('repo_url').notNull(), environment: text('environment').notNull().default('test'),
  sealedValues: text('sealed_values').notNull(), revision: integer('revision').notNull().default(1), updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, t => [uniqueIndex('pat_project_environment_scope').on(t.workspaceId, t.repoUrl, t.environment)]).enableRLS();

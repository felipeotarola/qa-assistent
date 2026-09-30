import { pgTable, text, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import type { RepoJob } from '../../../shared/repository';
export const repositories = pgTable('pat_repositories', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  url: text('url').notNull(), ref: text('ref').notNull().default(''), script: text('script').notNull().default('test'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [uniqueIndex('pat_repository_url_idx').on(t.workspaceId, t.url)]).enableRLS();
export const repositoryRuns = pgTable('pat_repository_runs', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  repositoryId: text('repository_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
  requestId: text('request_id').notNull(), config: jsonb('config').$type<{ url: string; ref: string; script: string; mode: 'inspect' | 'test'; args?: string[] }>().notNull(),
  job: jsonb('job').$type<RepoJob>(), createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [uniqueIndex('pat_repository_request_idx').on(t.workspaceId, t.requestId)]).enableRLS();

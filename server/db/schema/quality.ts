import { pgTable, text, integer, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import type { QualityConfig } from '../../../shared/quality';
export const workspaceQuality = pgTable('pat_workspace_quality', {
  workspaceId: text('workspace_id').primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  config: jsonb('config').$type<QualityConfig>().notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}).enableRLS();

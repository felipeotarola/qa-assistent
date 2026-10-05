import { pgTable, text, integer, timestamp, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { missionReports } from './missions';
export const reportShares = pgTable('pat_report_shares', {
  id: text('id').primaryKey(), reportId: text('report_id').notNull().references(() => missionReports.id, { onDelete: 'cascade' }), token: text('token').notNull(), mode: text('mode').$type<'public' | 'pin'>().notNull(), pinHash: text('pin_hash'), revision: integer('revision').notNull().default(1), evidenceIds: jsonb('evidence_ids').$type<string[]>().notNull(), expiresAt: timestamp('expires_at'), revokedAt: timestamp('revoked_at'), createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => [uniqueIndex('pat_report_share_token').on(t.token), index('pat_report_share_report').on(t.reportId)]).enableRLS();
export const reportShareSessions = pgTable('pat_report_share_sessions', {
  tokenHash: text('token_hash').primaryKey(), shareId: text('share_id').notNull().references(() => reportShares.id, { onDelete: 'cascade' }), revision: integer('revision').notNull(), expiresAt: timestamp('expires_at').notNull(),
}).enableRLS();
export const reportShareAttempts = pgTable('pat_report_share_attempts', {
  key: text('key').primaryKey(), count: integer('count').notNull().default(0), expiresAt: timestamp('expires_at').notNull(),
}).enableRLS();
export const reportShareAudit = pgTable('pat_report_share_audit', {
  id: text('id').primaryKey(), reportId: text('report_id').notNull().references(() => missionReports.id, { onDelete: 'cascade' }), userId: text('user_id').notNull(), action: text('action').notNull(), createdAt: timestamp('created_at').notNull().defaultNow(),
}).enableRLS();

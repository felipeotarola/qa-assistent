import { pgTable, text, integer, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import type { EnvironmentConsentPlan } from '../../../shared/project-environment-consent';

// A grant is immutable. Revocation changes only revokedAt/revision; renewal is
// another row. The audited setup ID is not a retention dependency for job logs.
export const environmentConsents = pgTable('pat_environment_consents', {
  id: text('id').primaryKey(), userId: text('user_id').notNull(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  runtime: text('runtime').notNull(), requestId: text('request_id').notNull(), grantSetupJobId: text('grant_setup_job_id').notNull(),
  repoUrl: text('repo_url').notNull(), environment: text('environment').notNull().default('test'),
  planHash: text('plan_hash').notNull(), plan: jsonb('plan').$type<EnvironmentConsentPlan>().notNull(),
  allowedNames: jsonb('allowed_names').$type<string[]>().notNull(), vaultRevision: integer('vault_revision').notNull(),
  revision: integer('revision').notNull().default(1),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('pat_environment_consent_request').on(t.workspaceId, t.runtime, t.requestId),
  index('pat_environment_consent_plan').on(t.workspaceId, t.runtime, t.repoUrl, t.planHash),
]).enableRLS();

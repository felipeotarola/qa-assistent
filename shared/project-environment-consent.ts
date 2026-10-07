import { z } from 'zod';
import { environmentName } from './project-environment.ts';
import type { EnvironmentConsentPlan } from './environment-plan-identity.mjs';
export { environmentPlanIdentity, canonicalEnvironmentPlan, type EnvironmentConsentPlan } from './environment-plan-identity.mjs';

export const ENVIRONMENT_CONSENT_DEFAULT_MS = 24 * 60 * 60 * 1000;
export const ENVIRONMENT_CONSENT_MAX_MS = 7 * ENVIRONMENT_CONSENT_DEFAULT_MS;
const planHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const allowedNamesSchema = z.array(environmentName).min(1).max(30).refine(names => new Set(names).size === names.length, 'Duplicate variable names').transform(names => [...names].sort());
export const grantEnvironmentConsentSchema = z.object({
  requestId: z.string().uuid(), expectedPlanHash: planHashSchema,
  expectedVaultRevision: z.number().int().positive(), allowedNames: allowedNamesSchema,
  expiresAt: z.string().datetime().optional(),
}).strict();
export const revokeEnvironmentConsentSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
// Server-only eligibility request, not a bearer credential and never a tool for
// supplying values. The dispatching controller also checks its current mandate.
export const authorizeEnvironmentConsentSchema = z.object({
  consentId: z.string().uuid(), consentRevision: z.number().int().positive(),
  setupJobId: z.string().uuid(), expectedPlanHash: planHashSchema, vaultRevision: z.number().int().positive(),
}).strict();
export type EnvironmentConsentView = {
  id: string; revision: number; grantSetupJobId: string; repoUrl: string; environment: 'test';
  plan: EnvironmentConsentPlan; planHash: string; allowedNames: string[]; vaultRevision: number;
  expiresAt: string; revokedAt: string | null; createdAt: string;
  status: 'active' | 'expired' | 'revoked' | 'outdated';
};
export type EnvironmentConsentStatus = {
  setupJobId: string; plan: EnvironmentConsentPlan | null; planHash: string | null;
  vaultRevision: number; configuredNames: string[]; missingNames: string[]; consents: EnvironmentConsentView[];
};
export type EnvironmentConsentAuthorization = {
  consentId: string; consentRevision: number; setupJobId: string; workspaceId: string;
  repoUrl: string; environment: 'test'; planHash: string; commit: string;
  allowedNames: string[]; vaultRevision: number; validUntil: string;
};

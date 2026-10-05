import { eq } from 'drizzle-orm';
import { schema } from '@nuxthub/db';
import { openEnvironment } from './environment-crypto';
import { environmentVaultScope } from './project-vault';
import type { WorkspaceDatabase } from './workspaces';
import { redactReportText } from '../../shared/mission';

/** Sanitize nested text without serializing and reparsing potentially escaped values. */
export function redactMissionValue<T>(value: T, redact: (s: string) => string): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map(v => redactMissionValue(v, redact)) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactMissionValue(v, redact)])) as T;
  return value;
}

/** Values are used only to remove accidental echoes, never returned to an agent. */
export async function missionRedactor(connection: WorkspaceDatabase, workspaceId: string) {
  const vault = await connection.select().from(schema.projectEnvironments).where(eq(schema.projectEnvironments.workspaceId, workspaceId));
  const secrets = [...Object.entries(process.env).filter(([key]) => /secret|token|password|api.?key/i.test(key)).map(([, value]) => value ?? ''),
    ...vault.flatMap(row => Object.entries(openEnvironment(row.sealedValues, environmentVaultScope(workspaceId, row.repoUrl))).filter(([key]) => !/_URL$/i.test(key)).map(([, value]) => value))].filter(s => s.length >= 6).sort((a, b) => b.length - a.length);
  const variants = [...new Set(secrets.flatMap(s => [s, encodeURIComponent(s), Buffer.from(s).toString('base64')]))].sort((a, b) => b.length - a.length);
  return (text: string) => variants.reduce((value, secret) => value.split(secret).join('[REDACTED]'), redactReportText(text));
}

import { z } from 'zod';

export const environmentName = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/).refine(name => !/^(?:PATH|HOME|SHELL|BASH_ENV|ENV|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|PYTHONPATH|PYTHONHOME|JAVA_TOOL_OPTIONS|GIT_.*|npm_config_.*)$/i.test(name), 'Reserved runtime variable');
export const environmentPlanSchema = z.object({
  repoUrl: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/),
  root: z.string().regex(/^\/workspace\/[\w./-]+$/),
  directory: z.string().regex(/^\/workspace\/[\w./-]+$/),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  command: z.string().min(1).max(2000), port: z.number().int().min(1024).max(65535),
  processId: z.string().uuid().optional(), httpStatus: z.number().int().min(100).max(599).nullable(),
  variables: z.array(z.object({ name: environmentName, reason: z.string().min(1).max(300), required: z.boolean() })).max(30),
}).refine(plan => ![plan.root, plan.directory].some(path => path.split('/').includes('..')) && (plan.directory === plan.root || plan.directory.startsWith(plan.root + '/')) && new Set(plan.variables.map(v => v.name)).size === plan.variables.length, 'Invalid project scope');
export type EnvironmentPlan = z.infer<typeof environmentPlanSchema>;
export const setupResultSchema = z.object({
  jobId: z.string().uuid(), id: z.string().uuid(), workspaceId: z.string().uuid(),
  status: z.enum(['starting', 'running', 'needs_configuration', 'configuring', 'completed', 'failed', 'cancelled', 'timeout', 'interrupted']),
  message: z.string().max(2000), result: z.string().max(16000).optional(),
  environment: environmentPlanSchema.optional(), updatedAt: z.string().max(100),
});
export type SetupResult = z.infer<typeof setupResultSchema>;
export interface SetupView {
  id: string; threadId: string; status: string; result: SetupResult | null;
  configuredNames: string[]; revision: number; notification: string;
}
export const environmentValuesSchema = z.record(environmentName, z.string().min(1).max(4000).refine(value => !value.includes('\0'))).refine(value => Object.keys(value).length <= 30, 'Too many variables');
export const configureEnvironmentSchema = z.object({ expectedRevision: z.number().int().nonnegative(), values: environmentValuesSchema, forget: z.array(environmentName).max(30).default([]), continue: z.boolean().default(false) });

// Import as data only: no shell expansion, sourcing or interpolation.
export function parseEnvironmentFile(text: string): Record<string, string> {
  if (text.length > 128000) throw new Error('Filen är för stor.');
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (!match) throw new Error('Använd en variabel per rad: NAMN=värde.');
    let value = match[2]!;
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0]; if (!value.endsWith(quote!) || value.length < 2) throw new Error('Flerradsvärden stöds inte vid filimport.');
      value = value.slice(1, -1);
    } else value = value.replace(/\s+#.*$/, '').trim();
    if (Object.hasOwn(values, match[1]!)) throw new Error('Filen innehåller dubbla variabelnamn.');
    values[match[1]!] = value;
  }
  return environmentValuesSchema.parse(values);
}

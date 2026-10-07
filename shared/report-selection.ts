import { z } from 'zod';

export const planDefinitionRefSchema = z.object({ type: z.literal('plan_definition'), id: z.string().uuid() }).strict();
const testSourceSchema = z.object({ type: z.literal('test'), id: z.string().uuid() }).strict();
export function testRunReportSource(id: string) { return testSourceSchema.parse({ type: 'test', id }); }

/** Allowlisted corrective metadata only. No source body, result, credential or
 * cross-workspace search is returned to the model by this error boundary. */
export const reportSelectionDiagnosticSchema = z.object({
  code: z.literal('REPORT_SOURCE_KIND_MISMATCH'),
  message: z.string().min(1).max(1000),
  rejected: z.array(z.object({ type: z.enum(['material', 'research']), id: z.string().uuid(), planVersion: z.number().int().positive() }).strict()).min(1).max(200),
  suggestions: z.array(z.object({ reportSource: testSourceSchema, itemId: z.string().uuid(), caseId: z.string().uuid(), planVersion: z.number().int().positive() }).strict()).max(10),
  suggestionsTruncated: z.boolean(),
}).strict();

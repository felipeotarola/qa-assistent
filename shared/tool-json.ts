import { z } from 'zod';

/** Some model gateways encode nested tool objects as JSON strings. Validate both
 * representations against the same contract; never accept unvalidated JSON. */
export function toolJson<S extends z.ZodType>(schema: S, maxLength = 200000) {
  return z.union([
    schema,
    z.string().max(maxLength).transform((value, ctx) => {
      try { return JSON.parse(value) as unknown; }
      catch { ctx.addIssue({ code: 'custom', message: 'Expected a valid JSON object' }); return z.NEVER; }
    }).pipe(schema),
  ]);
}

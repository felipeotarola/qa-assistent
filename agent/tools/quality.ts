import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { qualityUpdateSchema } from '../../shared/quality';
import { appOrigin, internalHeaders } from '../lib/internal-api';
export default defineTool({
  description: 'Read workspace quality, selected release/environment, readiness checks, regression selection and next test candidates. Update readiness only with observed evidence; unknown is not ready. Updates replace the config: preserve unrelated checks and regression choices. Changing target resets all checks to unknown. Never store credentials. Does not run tests or publish to Linear.',
  inputSchema: z.discriminatedUnion('action', [z.object({ action: z.literal('read') }), qualityUpdateSchema.extend({ action: z.literal('update') })]),
  async execute(input, ctx) {
    const auth = ctx.session.auth.current;
    if (auth?.authenticator !== 'app' || typeof auth.attributes.browserThreadId !== 'string') throw new Error('Requires workspace chat');
    const response = await fetch(`${appOrigin()}/api/internal/quality`, { method: 'POST', headers: internalHeaders(), signal: ctx.abortSignal, body: JSON.stringify({ ...input, userId: auth.principalId, threadId: auth.attributes.browserThreadId }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.statusMessage || 'Quality settings could not be saved');
    return result;
  },
});

import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { appOrigin, internalHeaders } from '../lib/internal-api';
export default defineTool({
  description: 'Read Klaras saved mission report/status by reportId. Read-only: no new review, tests or publication. Preserve caveats and distinguish reported outcomes from assessment verdicts. Report sharing is controlled by the owner in Material, never by this tool.',
  inputSchema: z.object({ reportId: z.string().uuid() }),
  async execute(input, ctx) {
    const auth = ctx.session.auth.current;
    if (auth?.authenticator !== 'app' || typeof auth.attributes.browserThreadId !== 'string') throw new Error('Authenticated workspace chat required');
    const response = await fetch(`${appOrigin()}/api/internal/mission-report`, { method: 'POST', headers: internalHeaders(), signal: ctx.abortSignal, body: JSON.stringify({ ...input, userId: auth.principalId, threadId: auth.attributes.browserThreadId }) });
    if (!response.ok) throw new Error('Report unavailable');
    return response.json();
  },
});

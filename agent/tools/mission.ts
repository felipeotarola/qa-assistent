import { defineTool } from 'eve/tools';
import { missionActionSchema } from '../../shared/mission';
import { appOrigin, internalHeaders } from '../lib/internal-api';
export default defineTool({
  description: 'Create and coordinate a bounded workspace mission. Create BEFORE delegation; record task criteria and bind actual job IDs using attach. config and task accept validated objects or their JSON encoding. Unknown target is null. Never infer mission membership from chat titles. read reconciles saved results, list lists missions. report queues Klara in the background, without retesting or publishing externally. Use returned reportId to read the saved report. Close only when registered tasks are terminal. Existing historical work may be explicitly attached by ID; do not pretend it was newly performed.',
  inputSchema: missionActionSchema,
  async execute(input, ctx) {
    const auth = ctx.session.auth.current;
    if (auth?.authenticator !== 'app' || typeof auth.attributes.browserThreadId !== 'string') throw new Error('Authenticated workspace chat required');
    const response = await fetch(`${appOrigin()}/api/internal/mission`, { method: 'POST', headers: internalHeaders(), signal: ctx.abortSignal, body: JSON.stringify({ ...input, userId: auth.principalId, threadId: auth.attributes.browserThreadId }) });
    if (!response.ok) throw new Error((await response.json()).statusMessage ?? 'Mission request failed');
    return response.json();
  },
});

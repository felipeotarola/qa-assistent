import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { appOrigin, internalHeaders } from '../lib/internal-api';
import { repositoryRequestId } from '../../shared/repository-request.mjs';
import { codexTurn } from '../lib/codex-turn';
export default defineTool({
  description: 'Delegate live browser tests to Iris in a durable background Eve session. start requires complete task with test plan ID, scope and URL. Returns immediately: end your turn so the user can continue chatting. status/cancel require jobId. No polling loop. Progress and final report appear in Pågående arbete.',
  inputSchema: z.object({ action: z.enum(['start', 'status', 'cancel']), task: z.string().min(1).max(16000).optional(), jobId: z.string().uuid().optional() }),
  async execute(input, ctx) {
    const auth = ctx.session.auth.current;
    if (auth?.authenticator !== 'app' || typeof auth.attributes.browserThreadId !== 'string' || auth.attributes.browserWorker) throw new Error('Requires the main workspace chat.');
    const response = await fetch(`${appOrigin()}/api/internal/browser-jobs`, { method: 'POST', headers: internalHeaders(), signal: ctx.abortSignal, body: JSON.stringify({ ...input, userId: auth.principalId, threadId: auth.attributes.browserThreadId, parentSessionId: ctx.session.id, model: auth.attributes.chatModel, reasoning: auth.attributes.reasoning, jobId: input.action === 'start' ? repositoryRequestId(auth.attributes.browserThreadId, ctx.callId) : input.jobId }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.statusMessage || 'Iris could not start.');
    if (['starting', 'running', 'dispatch_unknown'].includes(result.status)) codexTurn.update(() => ({ turnId: ctx.session.turn.id }));
    return result;
  },
});

import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { appOrigin, internalHeaders } from '../lib/internal-api';
import { repositoryRequestId } from '../../shared/repository-request.mjs';
import { codexTurn } from '../lib/codex-turn';
import { isCodexBackground } from '../../shared/codex-handoff.mjs';
import { repositoryMapTask } from '../../shared/repository-map';

export default defineTool({
  description: 'Delegate a repository setup/start/diagnosis task to the owner-only Codex subscription pilot on VPS. Uses THIS Eve sandbox, with existing files and processes, and shows logs in the Pågående arbete panel. start takes task; status/cancel take jobId. Returns immediately; running is not completed. While active, do NOT use bash/repository to perform the same work or change the sandbox. Read status before any retry. Once completed, read the report and use preview(port) for a verified running app. If pilot is not enabled or login is required, explain that; do not silently duplicate the job through another executor. Codex does not push or deploy.',
  inputSchema: z.object({ action: z.enum(['start', 'status', 'cancel']), task: z.string().min(1).max(12000).optional(), jobId: z.string().uuid().optional(), mode: z.enum(['setup', 'repository_map']).optional().describe('repository_map: read-only architecture map saved in Material. Include repositoryUrl and task scope (max 9000 characters).'), repositoryUrl: z.string().optional() }),
  async execute(input, ctx) {
    const auth = ctx.session.auth.current, threadId = auth?.attributes.browserThreadId;
    if (auth?.authenticator !== 'app' || !auth.principalId || typeof threadId !== 'string') throw new Error('Codex requires an authenticated workspace chat.');
    if (input.action === 'start' ? !input.task : !input.jobId) throw new Error('start requires task; status/cancel require jobId.');
    const task = input.action === 'start' && input.mode === 'repository_map' ? repositoryMapTask(input.repositoryUrl || '', input.task!) : input.task;
    const sandbox = await ctx.getSandbox();
    const response = await fetch(`${appOrigin()}/api/internal/codex`, {
      method: 'POST', headers: internalHeaders(), signal: AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(30000)]),
      body: JSON.stringify({ ...input, task, userId: auth.principalId, threadId, sessionKey: sandbox.id, parentSessionId:ctx.session.id,model:auth.attributes.chatModel,reasoning:auth.attributes.reasoning, jobId: input.action === 'start' ? repositoryRequestId(threadId, ctx.callId) : input.jobId }),
    });
    if (!response.ok) throw new Error((await response.json()).statusMessage || 'Codex worker request failed.');
    const result = await response.json();
    if (isCodexBackground(result)) {
      codexTurn.update(() => ({ turnId: ctx.session.turn.id }));
      return { ...result, background: true, nextAction: 'End this turn with a brief acknowledgement. The user can continue chatting. Progress streams independently to the Pågående arbete panel. Do not poll, wait in bash, or perform the delegated work. A background report returns to this chat when the registered setup job ends; use status only on a later user request.' };
    }
    return result;
  },
});

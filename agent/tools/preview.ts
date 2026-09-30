import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { appOrigin, internalHeaders } from '../lib/internal-api';

export default defineTool({
  description: 'Open an app running in this Eve VPS sandbox in the live workspace browser. First start the app on 0.0.0.0 using a background process and verify its local port. Creates a dedicated browser with access only to that app port, plus public websites. Use browser tools afterwards to inspect and interact; the user can take over. Stops when the sandbox stops or expires. This does not deploy the app publicly.',
  inputSchema: z.object({ port: z.number().int().min(1024).max(65535) }),
  async execute(input, ctx) {
    const auth = ctx.session.auth.current, threadId = auth?.attributes.browserThreadId;
    if (auth?.authenticator !== 'app' || !auth.principalId || typeof threadId !== 'string') throw new Error('Preview requires an authenticated workspace chat.');
    const sandbox = await ctx.getSandbox();
    const response = await fetch(`${appOrigin()}/api/internal/sandbox`, { method: 'POST', headers: internalHeaders(), body: JSON.stringify({ userId: auth.principalId, threadId, sessionKey: sandbox.id, agentId: ctx.session.parent ? ctx.session.id : 'main', input: { action: 'preview', ...input } }), signal: AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(60000)]) });
    if (!response.ok) throw new Error((await response.json()).statusMessage || 'The preview could not start. Check that the app listens on 0.0.0.0 and the requested port.');
    return response.json();
  },
});

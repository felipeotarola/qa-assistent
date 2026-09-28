import { defineTool } from 'eve/tools';
import { requirementToolSchema } from '../../shared/test-requirement';
import { appOrigin, internalHeaders } from '../lib/internal-api';
export default defineTool({
  description: 'LIST requirements/context decisions for a test case before testing. PROPOSE a specific missing-context question and optional clarification/expected result, linked to an existing Linear issueId and/or Material document sourceItemId. Read the plan first; use its expectedVersion and a stable requestId for retries. A proposal does not change requirements, publish to Linear or approve any run. The user reviews and publishes in the test case Requirements & context panel. Do not invent answers or treat unapproved drafts as requirements.',
  inputSchema: requirementToolSchema,
  async execute(input, ctx) {
    const auth = ctx.session.auth.current;
    const threadId = auth?.attributes.browserThreadId;
    if (auth?.authenticator !== 'app' || typeof threadId !== 'string') return { error: 'Requires a web chat' };
    const response = await fetch(`${appOrigin()}/api/internal/test-requirement`, { method: 'POST', headers: internalHeaders(), signal: ctx.abortSignal, body: JSON.stringify({ userId: auth.principalId, threadId, ...input }) });
    if (!response.ok) return { error: (await response.json().catch(() => ({}))).statusMessage || 'Proposal was not saved', status: response.status };
    return response.json();
  },
});

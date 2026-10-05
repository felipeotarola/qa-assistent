import { defineTool } from 'eve/tools';
import { testRunActionSchema } from '../../shared/test-run';
import { appOrigin, internalHeaders } from '../lib/internal-api';
export default defineTool({
  description: 'ASSESS requests Klara to review an existing finished run without rerunning tests. Use runId from LIST. Blocked and failed runs can be assessed; HTTP 200 is not a prerequisite. When the user asks for a review and assessments are empty, call ASSESS instead of only reporting the empty list. If asked only to summarize existing reviews, do not start a new review. Automatic review follows FINISH. Never repeatedly retry a failed assessment unless the user asks. LIST includes separate result assessments: always distinguish reported result from reviewed evidence; supported can mean a correctly reported failure. Do not announce reviewed success before an assessment exists. Persist real test executions separately from test definitions. START before testing with current plan version, stable requestId (reuse on retries), caseId and target environment URL. START returns the immutable case snapshot and required checks. FINISH must include checks for every returned ID, status and observed actual evidence to pass. Delegated partial scope never removes original requirements; untested steps mean inconclusive or blocked. FINISH with observed actual behavior, outcome, all unverified requirements, observations and saved workspace evidence IDs. LIST to inspect prior results. Never store execution results by editing the plan summary. Final results cannot be overwritten; reruns require a new requestId. An unfinished run is not a successful test.',
  inputSchema: testRunActionSchema,
  async execute(input, ctx) {
    const auth = ctx.session.auth.current;
    const threadId = auth?.attributes.browserThreadId;
    if (auth?.authenticator !== 'app' || typeof threadId !== 'string') return { error: 'Requires a web chat' };
    const response = await fetch(`${appOrigin()}/api/internal/test-run`, { method: 'POST', headers: internalHeaders(), signal: ctx.abortSignal, body: JSON.stringify({ userId: auth.principalId, threadId, ...input, browserJobId: auth.attributes.browserJobId }) });
    if (!response.ok) return { error: (await response.json().catch(() => ({}))).statusMessage || 'Run was not saved; do not claim success', status: response.status };
    return response.json();
  },
});

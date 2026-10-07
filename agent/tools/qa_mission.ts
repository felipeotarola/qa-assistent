import { browserInputMarker, priorUserMessageIdsSchema } from '../../shared/mission-request-context';
import { runtimeScope } from '../../shared/runtime-scope';
import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { missionIntakeAdmissionSchema } from '../../shared/mission-control';
import { repositoryRequestId } from '../../shared/repository-request.mjs';
import { appOrigin, internalHeaders } from '../lib/internal-api';
import { codexTurn } from '../lib/codex-turn';
import { reportSelectionDiagnosticSchema } from '../../shared/report-selection';

const { requestId: _requestId, goal: _goal, ...fields } = missionIntakeAdmissionSchema.shape;
export default defineTool({
  description: 'Start a bounded autonomous QA assignment from the user goal and a website URL or public GitHub repository. Use repository surface auto (or omit it at intake) for general repository QA with no chosen test surface; discovery first inspects actual project scripts. Explicit library/CLI/test-suite/static-check scope uses checks, including a requested suite that needs app startup as a prerequisite; never substitute browser QA for that suite. Requested running-app or browser behavior uses application, including conditional startup needed for that behavior; preserve it even when repository tests also exist. Checks runs the repository test/static-check command without claiming browser coverage. The backend checks reachability and network authorization; do not pre-reject a concrete HTTP(S) target based only on hostname or DNS assumptions. The saved mission discovers prerequisites, creates a QA plan, runs tests, asks only for necessary access, and delivers Klara\'s report independently of this chat. Use for ordinary requests to test a website, verify requirements, or run regression. No test plan or internal IDs required for explore. report_only summarizes explicit saved sourceRefs without new tests. Do not also start Iris/Otto/research manually for the same assignment. Returns immediately; acknowledge briefly and end the turn.',
  inputSchema: z.object({
    ...fields,
    intent: fields.intent.describe('explore discovers a bounded QA scope. verify executes selected saved cases or explicit requirements without adding a historical comparison. regression adds comparison against earlier results or a prior version only when the user requests that comparison; a plan title or existing history alone is not such a request. report_only summarizes selected saved evidence without new execution.'),
    sourceRefs: fields.sourceRefs.describe('Exact saved sources: for a test result copy its reportSource {type:"test",id:runId} from recentTestRuns or test_run LIST. A plan/item ID is not a run ID. material/research accepts documents, not test-plan definitions. Use {type:"plan_definition",id:planItemId} only when the user explicitly selected the definition itself; never to summarize its results. Do not add attached evidence or resolve run IDs from prose.'),
    caseKeys: fields.caseKeys.describe('Selected itemId:caseId values from the saved plan. For verify/regression or other new testing of selected saved cases, resolve the real item and case IDs and pass them here; the controller executes that selection. For report_only, these select the latest existing finished run per selected case without new tests; use explicit sourceRefs for explicitly selected run IDs instead. Never start the selected cases manually.'),
    priorUserMessageIds: priorUserMessageIdsSchema.describe('Only when the current request refers to earlier user requirements: copy their exact requestMessage IDs from the trusted chat reference index. These add full historical text as requirements context, never permission to repeat old work. For a self-contained request use []. The server preserves the full current user message; do not paraphrase it.'),
    target: fields.target.describe('For report_only, omit target or use null. Otherwise use {kind:"public_url",url:"https://..."} or {kind:"repository",url:"https://github.com/owner/repo",surface:"auto"|"checks"|"application"}. General repository QA with no chosen test surface uses auto (the intake default). Explicit library/CLI/test-suite/static-check scope uses checks. Running-app or browser behavior uses application, including conditional startup for that behavior. A startup prerequisite for an explicitly requested test suite does not authorize replacing it with browser QA. Never use a prose description as target.'),
  }).strict(),
  async execute(input, ctx) {
    const auth = ctx.session.auth.current, threadId = auth?.attributes.browserThreadId;
    if (auth?.authenticator !== 'app' || typeof threadId !== 'string' || auth.attributes.browserWorker || ctx.session.parent) throw new Error('Requires the main workspace chat.');
    const marker = browserInputMarker(auth.attributes);
    if (!marker) throw new Error('Requires a current authenticated user message.');
    const { priorUserMessageIds, ...admission } = input;
    const requestContext = { sessionId: ctx.session.id, turnId: ctx.session.turn.id, runtime: runtimeScope(), nonce: marker.nonce, priorUserMessageIds };
    const response = await fetch(`${appOrigin()}/api/internal/autonomy`, { method: 'POST', headers: internalHeaders(), signal: ctx.abortSignal,
      body: JSON.stringify({ userId: auth.principalId, threadId, requestContext, input: { action: 'accept', ...admission, requestId: repositoryRequestId(threadId, ctx.callId) } }),
    });
    const result = await response.json();
    if (!response.ok) {
      const diagnostic = reportSelectionDiagnosticSchema.safeParse(result.data);
      if (diagnostic.success) return { error: diagnostic.data.message, selectionError: diagnostic.data, accepted: false };
      throw new Error(result.statusMessage ?? 'QA-uppdraget kunde inte sparas.');
    }
    codexTurn.update(() => ({ turnId: ctx.session.turn.id }));
    return result;
  },
});

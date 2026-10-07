// Narrow public-origin supplement. No app/queue/model calls in this module.
import assert from 'node:assert/strict';
import { auditBoundedWebRuns, auditTrace, sha256 } from './autonomy-web-audit.mjs';
import { providerUsageSchema } from '../../shared/provider-usage.ts';
import { irisModelUsage, IRIS_MODEL_LEDGER_PREFIX } from '../../shared/browser-job.ts';

export const PUBLIC_URL_PROTOCOL = 'syna-public-url-acceptance-v2';
export const PUBLIC_URL = 'https://example.com/';
export const PUBLIC_PROMPT = 'Kontrollera att https://example.com kan öppnas och att startsidans synliga innehåll visas. Läs bara startsidan, följ inga länkar, logga inte in, skicka inte formulär och ändra inget. Spara en granskad QA-rapport.';
export const PUBLIC_CODE_FILES = ['tests/autonomy-public-url.acceptance.mjs', 'tests/helpers/public-url-acceptance.mjs',
  'tests/helpers/autonomy-web-audit.mjs', 'tests/helpers/utc-postgres-observation.mjs',
  'tests/helpers/autonomy-isolation.mjs', 'tests/helpers/start-isolated-app.mjs',
  'tests/helpers/isolated-build-integrity.mjs', 'tests/helpers/isolated-runtime-identity.mjs',
  'tests/helpers/isolated-workflow-store.mjs', 'shared/provider-usage.ts', 'shared/browser-job.ts'];

/** The owned Linux image builder decodes UTF-8 and replaces CRLF with LF before
 * copying and hashing these source files. Preserve every other byte distinction. */
export function publicBrowserSourceIdentity(bytes, buildSha256) {
  assert.ok(Buffer.isBuffer(bytes)); assert.match(buildSha256, /^[a-f0-9]{64}$/);
  const text = bytes.toString('utf8');
  assert.ok(Buffer.from(text, 'utf8').equals(bytes), 'Browser source must be valid UTF-8');
  const rawSha256 = sha256(bytes), normalizedSha256 = sha256(text.replaceAll('\r\n', '\n'));
  assert.equal(normalizedSha256, buildSha256, 'Browser policy build differs from reviewed source');
  return { rawSha256, normalizedSha256, normalization: 'utf8-crlf-to-lf-v1' };
}

/** Freeze the actual parser implementation used by both services and this observer. */
export function publicIrisLedgerPolicy(authored, web, eve) {
  assert.ok([authored, web, eve].every(Buffer.isBuffer));
  assert.deepEqual(web, eve, 'Frozen Iris ledger parsers disagree');
  assert.deepEqual(authored, web, 'Observer Iris parser differs from frozen product');
  return { version: 1, sourceSha256: sha256(authored) };
}

/** The Iris ledger is the physical-call record. Aggregate usage alone is not
 * evidence of a provider invocation. Unknown components stay unknown. */
export function publicIrisReceipt(attempt) {
  const ids = attempt?.iris_model_ledger;
  assert.ok(attempt?.kind === 'browser_tests' && Array.isArray(ids)
    && ids.every(id => typeof id === 'string' && id.startsWith(IRIS_MODEL_LEDGER_PREFIX)), 'Missing exact Iris model ledger');
  const usage = irisModelUsage(ids);
  assert.ok(!usage.invalid && usage.providerCalls > 0 && usage.measurementCounts.durationMs > 0, 'No valid physical Iris receipt for this current run');
  if (typeof attempt.usage?.tokens === 'number' && usage.tokens !== null) assert.equal(attempt.usage.tokens, usage.tokens, 'Iris aggregate disagrees with physical ledger');
  return { attemptId: attempt.id, ledgerSha256: sha256(JSON.stringify(ids)), providerCalls: usage.providerCalls,
    knownCalls: usage.knownCalls, unknownCalls: usage.unknownCalls, totalTokens: usage.tokens,
    inputTokens: usage.measurementCounts.inputTokens === usage.providerCalls ? usage.inputTokens : null, outputTokens: usage.measurementCounts.outputTokens === usage.providerCalls ? usage.outputTokens : null,
    cacheReadTokens: usage.measurementCounts.cacheReadTokens === usage.providerCalls ? usage.cacheReadTokens : null, cacheWriteTokens: usage.measurementCounts.cacheWriteTokens === usage.providerCalls ? usage.cacheWriteTokens : null,
    durationMs: usage.measurementCounts.durationMs === usage.providerCalls ? usage.durationMs : null };
}

export function publicUrlOptions(argv) {
  assert.ok(argv.every(arg => ['--audit', '--execute'].includes(arg) || /^--(?:repetitions|observation-seconds)=\d+$/.test(arg)), 'Unknown public URL option');
  const modes = argv.filter(arg => ['--audit', '--execute'].includes(arg)); assert.equal(modes.length, 1, 'Choose --audit or explicit --execute');
  const option = (key, fallback) => { const rows = argv.filter(arg => arg.startsWith(`--${key}=`)); assert.ok(rows.length <= 1); return rows.length ? Number(rows[0].split('=')[1]) : fallback; };
  const repetitions = option('repetitions', 1), observationSeconds = option('observation-seconds', 1500);
  assert.ok([1, 2, 3].includes(repetitions)); assert.ok(Number.isInteger(observationSeconds) && observationSeconds >= 60 && observationSeconds <= 1500);
  return { mode: modes[0], repetitions, observationSeconds, url: PUBLIC_URL, prompt: PUBLIC_PROMPT };
}

export async function observePublicUrl(sql, workspaceId, runtime) {
  return sql.begin('isolation level repeatable read read only', async tx => {
    const [missions, tasks, attempts, jobs, runs, reviews, reports, claims, events, captures, versions, browsers, reportItems, repositories, setups] = await Promise.all([
      tx`select id,thread_id,runtime,intent,lifecycle,phase,closure_reason,config,mandate,mandate_revision,plan_revision,lease_until,closed_at from pat_missions where workspace_id=${workspaceId} and runtime=${runtime}`,
      tx`select t.id,t.mission_id,t.state,t.spec,t.sources,t.plan_revision,t.supplement_round,t.operation_id,t.depends_on,t.created_at from pat_mission_tasks t join pat_missions m on m.id=t.mission_id where m.workspace_id=${workspaceId} and m.runtime=${runtime} order by t.created_at,t.id`,
      tx`select a.id,a.mission_id,a.task_id,a.kind,a.status,a.dispatch_id,a.operation_id,a.attempt_no,a.executor_resource_id,a.usage,a.tool_calls,a.created_at,a.finished_at,a.lease_until,a.deadline_at,a.plan_revision,a.mandate_revision,a.supplement_round,a.cancel_requested_at,
        coalesce((select jsonb_agg(marker.value order by marker.ordinality) from jsonb_array_elements_text(a.tool_call_ids) with ordinality marker(value,ordinality)
          where marker.value like 'server:iris-model:%'),'[]'::jsonb) as iris_model_ledger from pat_mission_attempts a join pat_missions m on m.id=a.mission_id where m.workspace_id=${workspaceId} and m.runtime=${runtime} order by a.created_at,a.id`,
      tx`select b.id,b.status,b.session_id,b.dispatch_lease_until from pat_browser_jobs b join pat_threads t on t.id=b.thread_id where t.workspace_id=${workspaceId} order by b.id`,
      tx`select id,item_id,case_id,plan_version,snapshot,target,runtime,result,started_at,finished_at,mission_attempt_id from pat_test_runs where workspace_id=${workspaceId} order by started_at,id`,
      tx`select id,run_id,status,assessment,input,input_hash,source_hash,reviewer_version,finished_at from pat_result_assessments where workspace_id=${workspaceId} and runtime=${runtime} order by created_at,id`,
      tx`select r.id,r.mission_id,r.status,r.item_id,r.document,r.usage,r.attempts,r.read_receipts,r.lease_until from pat_mission_reports r join pat_missions m on m.id=r.mission_id where m.workspace_id=${workspaceId} and m.runtime=${runtime} order by r.created_at,r.id`,
      tx`select id,state,owner,attempt_id from pat_mission_resource_claims where workspace_id=${workspaceId} order by id`,
      tx`select e.kind,e.payload,e.event_key,e.created_at from pat_mission_events e join pat_missions m on m.id=e.mission_id where m.workspace_id=${workspaceId} and m.runtime=${runtime} order by e.revision`,
      tx`select c.id,c.run_id,c.item_id,c.url,c.action,c.error,i.version,i.provenance,i.content,i.deleted_at from pat_test_captures c join pat_test_runs r on r.id=c.run_id left join pat_workspace_items i on i.id=c.item_id where r.workspace_id=${workspaceId} order by c.id`,
      tx`select v.item_id,v.version,v.created_at from pat_workspace_item_versions v join pat_workspace_items i on i.id=v.item_id where i.workspace_id=${workspaceId} and i.content->>'kind'='test_plan' order by v.item_id,v.version`,
      tx`select id,session_id,agent_id,control from pat_browser_assignments where workspace_id=${workspaceId} order by id`,
      tx`select i.id,i.version,i.deleted_at from pat_workspace_items i join pat_mission_reports r on r.item_id=i.id where i.workspace_id=${workspaceId} order by i.id`,
      tx`select id from pat_repository_runs where workspace_id=${workspaceId}`,
      tx`select id from pat_setup_jobs where workspace_id=${workspaceId}`,
    ]);
    return { missions, tasks, attempts, jobs, runs, reviews, reports, claims, events, captures, versions, browsers, reportItems, repositories, setups };
  });
}

export function auditPublicBytes(capture, bytes, state) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 4 * 1024 * 1024);
  assert.equal(bytes.length, capture.content.size); assert.equal(sha256(bytes), capture.provenance.sha256);
  assert.equal(capture.provenance.version, 1); assert.equal(capture.provenance.origin, 'tool');
  assert.equal(capture.provenance.sourceType, 'test'); assert.equal(capture.provenance.sourceId, capture.run_id);
  assert.ok(state.runs.some(run => run.id === capture.run_id));
  if (capture.provenance.producer === 'test-capture') { assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); return null; }
  assert.equal(capture.provenance.producer, 'browser-action');
  return auditTrace(capture, bytes, state);
}

/** No fixed remote page content is assumed. This checks a real page read and
 * the saved QA chain, never certifies arbitrary report prose or production. */
export function auditPublicCompletion(state, context) {
  assert.equal(state.missions.length, 1); const mission = state.missions[0];
  assert.equal(mission.runtime, context.runtime); assert.equal(mission.lifecycle, 'closed'); assert.ok(['investigated', 'criteria_satisfied'].includes(mission.closure_reason));
  assert.equal(mission.lease_until, null); assert.equal(mission.mandate.target.kind, 'public_url');
  assert.equal(new URL(mission.mandate.target.url).href, PUBLIC_URL);
  assert.deepEqual(mission.mandate.allowedOrigins, [new URL(PUBLIC_URL).origin]);
  assert.deepEqual(mission.mandate.repositoryUrls, []); assert.deepEqual(mission.mandate.consentIds, []);
  assert.equal(mission.config.target.revision, ''); assert.equal(mission.config.target.scope.kind, 'observation');
  assert.equal(state.repositories.length + state.setups.length + state.claims.length, 0, 'Unexpected execution or unreleased resource');
  assert.ok(state.browsers.every(b => !b.session_id && b.control !== 'human'));
  assert.ok(state.tasks.length && state.tasks.every(t => ['completed', 'blocked', 'cancelled'].includes(t.state)));
  assert.ok(state.attempts.length && state.attempts.every(a => ['completed', 'failed', 'cancelled'].includes(a.status) && a.finished_at && !a.lease_until));
  assert.ok(state.jobs.length && state.jobs.every(j => ['completed', 'failed'].includes(j.status) && !j.dispatch_lease_until));
  assert.equal(state.jobs.length, state.attempts.filter(a => a.kind === 'browser_tests').length, 'Browser attempt has no durable job receipt');
  for (const job of state.jobs) assert.ok(state.attempts.some(a => a.kind === 'browser_tests' && a.dispatch_id === job.id), 'Unbound browser job');
  const { currentRuns, complements, verifiedDefects } = auditBoundedWebRuns(state, context);
  const successfulReads = context.traces.filter(({ trace }) => trace.action === 'open' && trace.outcome === 'observed'
    && trace.toUrl === PUBLIC_URL && trace.httpStatus >= 200 && trace.httpStatus < 300 && trace.observation?.text?.trim() && !trace.observation.truncated);
  assert.ok(successfulReads.length, 'No actual complete HTTPS public page read');
  for (const { trace } of context.traces) {
    assert.ok(['open', 'inspect', 'screenshot', 'scroll'].includes(trace.action), 'Scope was start-page reading only');
    if (trace.outcome === 'observed' && trace.toUrl) assert.equal(new URL(trace.toUrl).href, PUBLIC_URL, 'Observed navigation left the permitted page');
  }
  const reports = state.reports.filter(r => r.status === 'completed' && r.item_id);
  assert.equal(reports.length, 1); assert.equal(state.reports.length, 1); const report = reports[0];
  assert.equal(report.document.partial, false); assert.equal(report.lease_until, null);
  assert.equal(state.reportItems.length, 1); assert.equal(state.reportItems[0].id, report.item_id); assert.equal(state.reportItems[0].version, 1); assert.ok(!state.reportItems[0].deleted_at);
  const reportAttempt = state.attempts.find(a => a.kind === 'report' && a.executor_resource_id === report.id && a.status === 'completed');
  assert.ok(reportAttempt && providerUsageSchema.parse(reportAttempt.usage.provider).providerCalls > 0, 'No actual report-bound provider receipt');
  assert.ok(state.attempts.some(a => a.kind === 'planning' && a.status === 'completed'
    && providerUsageSchema.safeParse(a.usage?.provider).success && a.usage.provider.providerCalls > 0), 'No actual planning provider receipt');
  assert.deepEqual(report.document.tests.map(t => t.runId).sort(), currentRuns.map(r => r.id).sort(), 'Report changed the selected current runs');
  const irisReceipts = new Map();
  for (const run of currentRuns) {
    const browserAttempt = state.attempts.find(a => a.id === run.mission_attempt_id);
    irisReceipts.set(browserAttempt?.id, publicIrisReceipt(browserAttempt));
    const reviewTasks = state.tasks.filter(t => t.spec?.kind === 'review' && t.spec.runIds?.includes(run.id));
    assert.ok(state.attempts.some(a => a.kind === 'review' && a.status === 'completed' && reviewTasks.some(t => t.id === a.task_id)
      && providerUsageSchema.safeParse(a.usage?.provider).success && a.usage.provider.providerCalls > 0), 'No physical review receipt for this current run');
    const rows = report.document.tests.filter(t => t.runId === run.id); assert.equal(rows.length, 1);
    assert.equal(rows[0].originalOutcome, run.result.outcome); assert.equal(rows[0].status, run.result.outcome); assert.equal(rows[0].review, 'supported');
    assert.ok(report.document.evidence.some(e => e.read && context.byteEvidence.has(e.itemId)
      && state.captures.some(c => c.item_id === e.itemId && c.run_id === run.id)
      && report.read_receipts.some(r => r.id === e.id && !r.limited && r.digest === state.captures.find(c => c.item_id === e.itemId).provenance.sha256)), 'Current run lacks report evidence read');
  }
  assert.ok(report.document.findings.length && report.document.findings.every(f => f.verdict === 'supported' && f.evidenceIds.length
    && f.evidenceIds.every(id => report.read_receipts.some(r => r.id === id && !r.limited && /^[a-f0-9]{64}$/.test(r.digest ?? '')))));
  return { reportId: report.id, currentRunIds: currentRuns.map(r => r.id), publicReadItemIds: successfulReads.map(r => r.capture.item_id),
    irisReceipts: [...irisReceipts.values()], complements, verifiedDefects, reportProse: 'independent_review_pending', fullGate: false,
    effectScope: 'No external write is authorized. Saved browser actions stayed within start-page reading; arbitrary server-side effects of public GETs are not independently observable.' };
}

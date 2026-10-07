import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { and, eq } from 'drizzle-orm';
import { isolatedApp } from './isolated-app.mjs';

/** Authored controller + planning, run, review and report persistence on actual
 * isolated PostgreSQL. Only page acquisition, model generation and browser
 * execution are synthetic. This is fault injection, not live QA acceptance. */
export async function controllerFixture() {
  process.env.PAT_RUNTIME_SCOPE = `${process.env.PAT_RUNTIME_SCOPE}-controller-${randomUUID()}`;
  process.env.MISSIONS_ENABLED = 'true'; process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true';
  process.env.MISSION_REPORTS_ENABLED = 'true';
  const app = await isolatedApp(), { db, schema } = app;
  const control = await import('../../server/utils/mission-control.ts');
  const attempts = await import('../../server/utils/mission-attempts.ts');
  const missions = await import('../../server/utils/missions.ts');
  const { saveItem } = await import('../../server/utils/workspaces.ts');
  const { testRunAction } = await import('../../server/utils/test-runs.ts');
  const owner = randomUUID(), contexts = new Map(), calls = [], originalFetch = globalThis.fetch;
  const row = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
  const rows = (table, id) => db.select().from(table).where(eq(table.missionId, id));
  const scripts = {
    async researchPage(userId, threadId, input) {
      const f = contexts.get(input.mission.missionId); assert.equal(userId, owner); assert.equal(threadId, f.thread);
      calls.push({ kind: 'research', missionId: f.id });
      const item = await saveItem(owner, f.workspace, { title: 'Synthetic observed page', threadId,
        content: { kind: 'text', text: JSON.stringify({ title: 'Observed navigation', text: 'Browse our articles.', links: [{ url: `${f.target.url}articles`, label: 'Articles' }] }) } }, db,
      { provenance: { version: 1, origin: 'tool', producer: 'research-page', sourceType: 'research', observedAt: new Date().toISOString(), url: f.target.url } });
      await missions.bindMissionSource(owner, f.workspace, threadId, input.mission, 'research', item.id);
      return { sourceItem: item };
    },
    async planMission(input) {
      calls.push({ kind: 'plan', goal: input.goal });
      return { draft: { schemaVersion: 1, title: 'Synthetic bounded plan', summary: 'An observed navigation check.', cases: [{ title: 'Observed navigation', entryUrl: input.sources[0].url,
        steps: [{ action: 'Open Articles using the observed navigation link.', expected: 'The Articles page is shown.' }],
        basis: { kind: 'exploratory', quote: '', source: { itemId: input.sources[0].itemId, version: input.sources[0].version } } }], limitations: ['Synthetic model output for controller integration.'] }, usage: { tokens: 120, toolCalls: 0, durationMs: 1 } };
    },
    async browserJobAction(userId, threadId, input) {
      const [attempt] = await db.select().from(schema.missionAttempts).where(eq(schema.missionAttempts.dispatchId, input.jobId));
      const f = contexts.get(attempt.missionId); assert.equal(userId, owner); assert.equal(threadId, f.thread);
      calls.push({ kind: `browser:${input.action}`, missionId: f.id, jobId: input.jobId, attemptId: attempt.id });
      let job = await row(schema.browserJobs, input.jobId);
      if (input.action === 'start') {
        if (!job) {
          [job] = await db.insert(schema.browserJobs).values({ id: input.jobId, threadId, runtime: process.env.PAT_RUNTIME_SCOPE,
            task: input.task, parentSessionId: input.parentSessionId, model: input.model, reasoning: input.reasoning,
            status: f.mode === 'unknown' ? 'dispatch_unknown' : f.mode === 'preadmission' ? 'starting' : 'running' }).returning();
          await missions.bindMissionSource(owner, f.workspace, threadId, input.mission, 'browser', job.id);
          if (f.mode === 'preadmission') { f.mode = 'running'; throw new Error('Synthetic transport failed before admission'); }
        } else if (job.status === 'starting') [job] = await db.update(schema.browserJobs).set({ status: 'running' }).where(eq(schema.browserJobs.id, job.id)).returning();
      }
      assert.ok(job, 'Synthetic worker only observes an already persisted job');
      if (input.action === 'cancel') [job] = await db.update(schema.browserJobs).set({ status: f.mode === 'unknown' ? 'cancelling' : 'cancelled', updatedAt: new Date() }).where(eq(schema.browserJobs.id, job.id)).returning();
      return { ...job, retryableDispatch: job.status === 'starting' };
    },
    async controlBrowser(...args) {
      calls.push({ kind: 'browser:control', userId: args[0], threadId: args[1], action: args[2], sessionId: args[3], options: args[4] });
      return (await import('../../server/utils/browser.ts')).controlBrowser(...args);
    },
    async vpsBrowserRequest(path, method) {
      assert.equal(method, 'DELETE'); assert.match(path, /^\/sessions\/fixture-browser-/);
      calls.push({ kind: 'provider:delete', path });
      return { ok: true };
    },
    currentMissionDelivery: missions.currentMissionDelivery,
    async requestMissionReport(...args) {
      const result = await missions.requestMissionReport(...args);
      const f = contexts.get(args[2]); calls.push({ kind: 'report:queue', missionId: f.id, reportId: result.reportId });
      if (f.crashAfterReportQueue) {
        f.crashAfterReportQueue = false;
        // The report transaction has committed; crash loses the app/controller
        // acknowledgement. Report and attempt binding must already be atomic.
        await db.update(schema.missions).set({ leaseUntil: new Date(0) }).where(eq(schema.missions.id, f.id));
        throw Object.assign(new Error('Synthetic process loss after report queue commit'), { statusCode: 409 });
      }
      return result;
    },
    async writeMissionReport(snapshot) {
      calls.push({ kind: 'report:model', missionId: snapshot.missionId });
      return { draft: { summary: 'Synthetic report generation; no live QA conclusion is claimed.', findings: snapshot.config.criteria.map(c => ({ criterionId: c.id,
        verdict: 'needs_evidence', conclusion: 'Saved observations are incomplete.', evidenceIds: [], observations: [], nextStep: 'Collect independent execution evidence.' })), limitations: ['Synthetic model used for controller integration.'] },
      usage: { inputTokens: 20, outputTokens: 20, totalTokens: 40, steps: 1 } };
    },
    async assessResult(input, _attachments, _signal, onUsage) {
      onUsage?.(0);
      return { verdict: 'needs_evidence', summary: 'Synthetic review fixture', findings: input.requirements.map(r => ({ requirementId: r.id, verdict: 'needs_evidence', explanation: 'Synthetic fixture only', evidenceIds: [], suggestedNextStep: 'Collect independent evidence', gap: { kind: 'missing_observation', capability: 'none', wantedEvidence: 'Independent evidence of the original fixture checkpoint.' } })) };
    },
  };
  globalThis.missionControllerFixtureExecutors = scripts;
  const controllerUrl = new URL('../../server/utils/mission-controller.ts', import.meta.url).href;
  const reportUrl = new URL('../../server/utils/mission-reports.ts', import.meta.url).href;
  const reviewUrl = new URL('../../server/utils/result-review-worker.ts', import.meta.url).href;
  const browserUrl = new URL('../../server/utils/browser.ts', import.meta.url).href;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    let names;
    if (context.parentURL === controllerUrl) names = ({ './research': ['researchPage'], './browser-jobs': ['browserJobAction'], './browser': ['controlBrowser'], './missions': ['currentMissionDelivery', 'requestMissionReport'], '../../agent/lib/mission-planner': ['planMission', 'MissionPlanningError'] })[specifier];
    if (context.parentURL === reportUrl && specifier === '../../agent/lib/mission-reporter') names = ['writeMissionReport'];
    if (context.parentURL === reviewUrl && specifier === '../../agent/lib/result-reviewer') names = ['assessResult'];
    if (context.parentURL === browserUrl && specifier === './vps-browser') names = ['vpsBrowserRequest'];
    if (!names) return next(specifier, context);
    const source = names.map(name => name === 'MissionPlanningError' ? 'export class MissionPlanningError extends Error { constructor(usage, diagnostic) { super("Synthetic safe planner failure"); this.usage = usage; this.diagnostic = diagnostic; } }; globalThis.missionControllerFixtureExecutors.MissionPlanningError = MissionPlanningError;' : `export const ${name} = (...args) => globalThis.missionControllerFixtureExecutors.${name}(...args);`).join('\n');
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  } });
  const { runMissionController, reconcileClosedMissionResources } = await import('../../server/utils/mission-controller.ts');
  const { processReviewQueue } = await import('../../server/utils/result-review-worker.ts');
  const { processMissionReport } = await import('../../server/utils/mission-reports.ts');
  globalThis.fetch = () => { throw new Error('External network is forbidden in controller integration'); };
  await db.insert(schema.user).values({ id: owner, name: 'Controller integration', email: `${owner}@example.test` });
  async function fixture(options = {}) {
    const workspace = randomUUID(), thread = randomUUID(), target = options.target ?? { kind: 'public_url', url: 'https://controller.example.test/' };
    await db.insert(schema.workspaces).values({ id: workspace, userId: owner, name: 'Controller fixture' });
    await db.insert(schema.threads).values({ id: thread, userId: owner, workspaceId: workspace, title: 'Controller fixture' });
    let sourceRefs = [];
    if (options.intent === 'report_only') {
      const item = await saveItem(owner, workspace, { title: 'Already saved notes', content: { kind: 'text', text: 'Synthetic saved report-only input.' } });
      sourceRefs = [{ type: 'material', id: item.id }];
    }
    const mission = await control.acceptMission(owner, workspace, thread, { requestId: randomUUID(), intent: options.intent ?? 'explore', goal: options.goal ?? 'Check public navigation and report what is verified.', target, sourceRefs });
    const f = { ...mission, workspace, thread, target, mode: options.mode ?? 'running' }; contexts.set(mission.id, f); return f;
  }
  async function pass(f) {
    await db.update(schema.missions).set({ nextWakeAt: new Date(0) }).where(eq(schema.missions.id, f.id));
    return runMissionController(f.id);
  }
  const state = async f => ({ mission: await row(schema.missions, f.id), tasks: await rows(schema.missionTasks, f.id), attempts: await rows(schema.missionAttempts, f.id), claims: await rows(schema.missionResourceClaims, f.id), reports: await rows(schema.missionReports, f.id) });
  async function until(f, predicate, limit = 12) { for (let i = 0; i < limit; i++) { const s = await state(f); if (predicate(s)) return s; await pass(f); } const s = await state(f); assert.ok(predicate(s), `Controller did not reach expected state: ${JSON.stringify({ lifecycle: s.mission.lifecycle, phase: s.mission.phase, tasks: s.tasks.map(t => [t.spec.kind, t.state]), attempts: s.attempts.map(a => [a.kind, a.status]) })}`); return s; }
  const browserReady = f => until(f, s => s.attempts.some(a => a.kind === 'browser_tests'));
  async function finishBrowser(f) {
    const s = await state(f), attempt = s.attempts.find(a => a.kind === 'browser_tests'), task = s.tasks.find(t => t.id === attempt.taskId), result = [];
    const execution = { execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId } };
    for (const key of task.spec.caseKeys) {
      const [itemId, caseId] = key.split(':');
      const run = await testRunAction(owner, f.workspace, f.thread, { action: 'start', itemId, caseId, expectedVersion: task.spec.planVersions.find(p => p.itemId === itemId).version,
        requestId: randomUUID(), environment: task.spec.target.environment, target: task.spec.target, mission: { missionId: f.id, taskId: task.id } }, execution);
      await testRunAction(owner, f.workspace, f.thread, { action: 'finish', runId: run.id, result: { outcome: 'inconclusive', actual: 'Synthetic worker saved partial observations.', unverified: 'No actual browser is invoked by this integration fixture.', observations: [], evidenceItemIds: [] } }, execution);
      result.push(run);
    }
    await db.update(schema.browserJobs).set({ status: 'completed', report: 'Synthetic browser executor completed with explicit inconclusive results.', updatedAt: new Date() }).where(eq(schema.browserJobs.id, attempt.dispatchId));
    return result;
  }
  async function workers(f) {
    for (const job of await db.select().from(schema.resultAssessments).where(and(eq(schema.resultAssessments.workspaceId, f.workspace), eq(schema.resultAssessments.status, 'queued')))) {
      assert.ok(job); await processReviewQueue();
    }
    if ((await rows(schema.missionReports, f.id)).some(r => r.status === 'queued')) await processMissionReport();
  }
  async function settle(f, limit = 15) {
    for (let i = 0; i < limit; i++) { await workers(f); await pass(f); const s = await state(f); if (s.mission.lifecycle === 'closed') return s; }
    assert.fail(`Mission did not close: ${JSON.stringify((await state(f)).tasks.map(t => [t.spec.kind, t.state]))}`);
  }
  const operate = async (f, action) => control.controlMission(owner, f.workspace, f.thread, { action, missionId: f.id, requestId: randomUUID(), expectedMandateRevision: (await row(schema.missions, f.id)).mandateRevision });
  async function closedClaim(options = {}) {
    const f = await fixture({ mode: options.unknown ? 'unknown' : 'running' }), ready = await browserReady(f), attempt = ready.attempts.find(a => a.kind === 'browser_tests');
    // Fault injection: controller has delivered its bounded partial result while
    // the physical resource remains reserved pending a later executor receipt.
    await db.update(schema.missionAttempts).set({ status: 'failed', finishedAt: new Date(), error: 'Synthetic uncertain stop' }).where(eq(schema.missionAttempts.id, attempt.id));
    await db.update(schema.missions).set({ lifecycle: 'closed', status: 'closed', phase: 'idle', closedAt: new Date(), closureReason: 'deadline' }).where(eq(schema.missions.id, f.id));
    await db.update(schema.missionResourceClaims).set({ state: 'uncertain' }).where(eq(schema.missionResourceClaims.attemptId, attempt.id));
    await db.update(schema.browserJobs).set({ status: options.unknown ? 'cancelling' : 'cancelled', updatedAt: new Date() }).where(eq(schema.browserJobs.id, attempt.dispatchId));
    return { ...f, attempt, claim: (await rows(schema.missionResourceClaims, f.id))[0] };
  }
  async function assignment(f, { human = false, expired = false } = {}) {
    const agentId = `fixture-iris-${randomUUID()}`, sessionId = `fixture-browser-${randomUUID()}`, id = randomUUID();
    await db.update(schema.browserJobs).set({ sessionId: agentId }).where(eq(schema.browserJobs.id, f.attempt.dispatchId));
    await db.insert(schema.browserAssignments).values({ id, workspaceId: f.workspace, userId: owner, threadId: f.thread, agentId, sessionId, projectId: 'self-hosted-v1',
      control: human ? 'human' : 'agent', liveUrl: 'https://viewer.example.test/', expiresAt: new Date(Date.now() + (expired ? -60000 : 60000)) });
    await db.update(schema.missionResourceClaims).set({ owner: human ? 'human' : 'agent', executorResourceId: sessionId }).where(eq(schema.missionResourceClaims.id, f.claim.id));
    return row(schema.browserAssignments, id);
  }
  return { ...app, owner, fixture, pass, state, until, browserReady, finishBrowser, workers, settle, operate, row, rows, calls, scripts, control, attempts, saveItem, missions, closedClaim, assignment, reconcileClosedMissionResources,
    async close() { globalThis.fetch = originalFetch; hooks.deregister(); delete globalThis.missionControllerFixtureExecutors; await db.delete(schema.user).where(eq(schema.user.id, owner)); await app.close(); } };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import ts from 'typescript';
import { browserReturnReceiptSchema } from '../shared/mission-browser-return.ts';
import { browserSessionContextSchema, reviewRules, validateAssessment, REVIEWER_VERSION, REVIEW_HASH_VERSION } from '../shared/result-assessment.ts';
import { runChecks } from '../shared/test-run.ts';
import { normalizeEvidenceProvenance, EVIDENCE_POLICY_VERSION } from '../shared/evidence-provenance.ts';
import { assessResult } from '../agent/lib/result-reviewer.ts';

const source = await readFile(new URL('../server/utils/mission-browser-return.ts', import.meta.url), 'utf8');
const reviews = await readFile(new URL('../server/utils/result-assessments.ts', import.meta.url), 'utf8');
const controller = await readFile(new URL('../server/utils/mission-controller.ts', import.meta.url), 'utf8');
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
const hash = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
function compile(code, ports, name) {
  const js = ts.transpileModule(code.replaceAll('export ', ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(...Object.keys(ports), `${js};return ${name};`)(...Object.values(ports));
}
function table(name) { return new Proxy({ name }, { get: (t, k) => k === 'name' ? t.name : { table: name, key: k } }); }
const schema = Object.fromEntries(['missions', 'missionAttempts', 'missionTasks', 'missionEvents', 'missionWaits', 'testRuns', 'testCaptures', 'workspaceItems', 'jobs'].map(n => [n, table(n)]));
const eq = (field, value) => row => row[field.key] === value;
const and = (...predicates) => row => predicates.filter(Boolean).every(p => p(row));
const inArray = (field, values) => row => values.includes(row[field.key]);
function reader(rows) {
  const reads = [];
  return { reads, select: () => ({ from(t) { reads.push(t.name); return { where(predicate) {
    const result = Promise.resolve((rows[t.name] ?? []).filter(predicate));
    result.orderBy = () => result; result.limit = n => result.then(v => v.slice(0, n)); return result;
  } }; } }) };
}
const context = { version: 1, kind: 'human_returned_session', priorAuthentication: 'unknown' };
const project = compile(source.slice(source.indexOf('export async function browserReturnContext(')), { schema, eq, and, inArray, browserReturnReceiptSchema, missionHash: hash, canonicalHash: hash, receiptKey: id => `browser-returned:${id}`, handoffKey: id => `browser-return-handoff:${id}` }, 'browserReturnContext');

function fixture() {
  const ids = Object.fromEntries(['mission', 'task', 'prior', 'attempt', 'dispatch', 'priorDispatch', 'wait', 'assignment', 'session', 'claim', 'item', 'case', 'run'].map(k => [k, randomUUID()]));
  const at = ms => new Date(Date.UTC(2026, 9, 6, 10) + ms), key = `${ids.item}:${ids.case}`;
  const scope = { workspaceId: 'workspace', threadId: 'thread', runtime: 'isolated', userId: 'owner', attemptId: ids.attempt };
  const spec = { kind: 'browser_tests', caseKeys: [key], planVersions: [{ itemId: ids.item, version: 1 }] };
  const requestHash = hash({ spec, planRevision: 1, mandateRevision: 1 });
  const original = { id: ids.prior, missionId: ids.mission, taskId: ids.task, runtime: scope.runtime, kind: 'browser_tests', requestHash, dispatchId: ids.priorDispatch, attemptNo: 1, planRevision: 1, mandateRevision: 1, deadlineAt: at(60000), createdAt: at(0) };
  const attempt = { ...original, id: ids.attempt, dispatchId: ids.dispatch, attemptNo: 2, deadlineAt: at(50000), createdAt: at(5000) };
  const receipt = { version: 1, taskId: ids.task, waitId: ids.wait, sourceAttemptId: ids.prior, sourceDispatchId: ids.priorDispatch, assignmentId: ids.assignment, physicalSessionId: ids.session, claimId: ids.claim, runtime: scope.runtime, requestHash, policyDigest: 'a'.repeat(64), planRevision: 1, mandateRevision: 1, deadlineAt: at(60000).toISOString(), blockedRunId: null };
  const rows = {
    missions: [{ id: ids.mission, workspaceId: scope.workspaceId, userId: scope.userId, threadId: scope.threadId, runtime: scope.runtime, lifecycle: 'closed', mandateRevision: 2 }],
    missionTasks: [{ id: ids.task, missionId: ids.mission, planRevision: 1, spec }], missionAttempts: [original, attempt],
    missionEvents: [
      { missionId: ids.mission, kind: 'browser_return_handoff', eventKey: `browser-return-handoff:${ids.attempt}`, createdAt: at(5000), payload: { attemptId: ids.attempt, dispatchId: ids.dispatch, receipt, caseKeys: [key] } },
      { missionId: ids.mission, kind: 'browser_returned', eventKey: `browser-returned:${ids.wait}`, createdAt: at(2000), payload: { receipt: structuredClone(receipt) } },
    ],
    missionWaits: [{ id: ids.wait, missionId: ids.mission, state: 'answered', definition: { reason: 'human_browser', taskIds: [ids.task], planRevision: 1, mandateRevision: 1 }, answer: { kind: 'browser_returned', sessionId: ids.session }, createdAt: at(1000), answeredAt: at(2020), deadlineAt: at(60000) }],
    testRuns: [{ id: ids.run, missionAttemptId: ids.attempt, workspaceId: scope.workspaceId, threadId: scope.threadId, runtime: scope.runtime, itemId: ids.item, caseId: ids.case, planVersion: 1, browserEntryReceipt: { sessionId: ids.session }, startedAt: at(6000), finishedAt: at(9000), target: { url: 'https://example.test/account', environment: 'test', revision: 'r1' }, environment: 'test', snapshot: { title: 'Account', preconditions: '', steps: 'Read the profile.', expected: 'Own profile details are visible.' }, result: { outcome: 'passed', actual: 'Own details appeared without a new login challenge.', unverified: '', observations: [], checks: [{ id: 'step-1', status: 'verified', actual: 'Own details appeared without a new login challenge.' }], evidenceItemIds: [] } }],
    testCaptures: [], workspaceItems: [], jobs: [],
  };
  return { rows, scope, run: rows.testRuns[0], at, ids, receipt };
}
test('exact immutable return projects only unknown authentication after cleanup and later mission epoch', async () => {
  const f = fixture(), db = reader(f.rows), before = structuredClone(f.rows);
  assert.deepEqual(await project(db, f.scope, f.run), context); assert.deepEqual(await project(db, f.scope), context);
  assert.deepEqual(f.rows, before); assert.equal(db.reads.some(n => /claim|assignment|job/i.test(n)), false);
  assert.deepEqual(Object.keys(context).sort(), ['kind', 'priorAuthentication', 'version']);
});
test('missing receipt and original active attempt stay unknown; no fabricated takeover or clean session', async () => {
  for (const change of [f => { f.rows.missionEvents = []; }, f => { f.scope.attemptId = f.ids.prior; }, f => { f.rows.missionWaits = []; }]) {
    const f = fixture(); change(f); assert.equal(await project(reader(f.rows), f.scope), undefined);
  }
});
test('ordinary attempts use exactly two reads; attested returns keep all seven identity reads', async () => {
  const f = fixture(); f.rows.missionEvents = [];
  const ordinary = reader(f.rows);
  assert.equal(await project(ordinary, f.scope, f.run), undefined);
  assert.deepEqual(ordinary.reads, ['missionAttempts', 'missionEvents']);
  const returned = fixture(), complete = reader(returned.rows);
  assert.deepEqual(await project(complete, returned.scope, returned.run), context);
  assert.deepEqual(complete.reads, ['missionAttempts', 'missionEvents', 'missions', 'missionTasks', 'missionEvents', 'missionWaits', 'missionAttempts']);
  const foreign = reader(returned.rows);
  assert.equal(await project(foreign, { ...returned.scope, userId: 'another-owner' }, returned.run), undefined);
  assert.deepEqual(foreign.reads, ['missionAttempts', 'missionEvents', 'missions'], 'Early existence read must not bypass owner validation');
});
test('foreign owner/workspace/thread/runtime and substituted task/attempt/dispatch never project context', async () => {
  for (const change of [f => { f.scope.userId = 'foreign'; }, f => { f.scope.workspaceId = 'foreign'; }, f => { f.scope.threadId = 'foreign'; }, f => { f.scope.runtime = 'foreign'; }, f => { f.rows.missionTasks[0].missionId = 'foreign'; }, f => { f.rows.missionEvents[0].payload.attemptId = randomUUID(); }, f => { f.rows.missionEvents[0].payload.dispatchId = randomUUID(); }]) {
    const f = fixture(); change(f); assert.equal(await project(reader(f.rows), f.scope, f.run), undefined);
  }
});
test('receipt mismatch, mutation, epochs, request hash and original attempt provenance are rejected', async () => {
  for (const change of [f => { f.rows.missionEvents[1].payload.receipt.physicalSessionId = randomUUID(); }, f => { f.receipt.mandateRevision = 2; }, f => { f.receipt.planRevision = 2; }, f => { f.receipt.requestHash = 'b'.repeat(64); }, f => { f.receipt.loginVerified = true; }, f => { f.rows.missionAttempts[0].runtime = 'foreign'; }, f => { f.rows.missionAttempts[0].taskId = randomUUID(); }, f => { f.rows.missionAttempts[0].dispatchId = randomUUID(); }, f => { f.rows.missionAttempts[0].deadlineAt = f.at(61000); }, f => { f.rows.missionAttempts[0].attemptNo = 3; }]) {
    const f = fixture(); change(f); assert.equal(await project(reader(f.rows), f.scope, f.run), undefined);
  }
});
test('only exact answered human wait/session and original deadline qualify, without clock tolerance', async () => {
  for (const change of [f => { f.rows.missionWaits[0].state = 'expired'; }, f => { f.rows.missionWaits[0].answer.sessionId = randomUUID(); }, f => { f.rows.missionWaits[0].definition.taskIds = []; }, f => { f.rows.missionWaits[0].definition.reason = 'configuration'; }, f => { f.rows.missionWaits[0].answeredAt = f.at(5001); }, f => { f.rows.missionWaits[0].deadlineAt = f.at(2010); }, f => { f.rows.missionEvents[1].createdAt = f.at(999); }]) {
    const f = fixture(); change(f); assert.equal(await project(reader(f.rows), f.scope, f.run), undefined);
  }
});
test('review context requires the resumed run selection, plan, runtime and observed physical session', async () => {
  for (const change of [f => { f.run.missionAttemptId = f.ids.prior; }, f => { f.run.runtime = 'foreign'; }, f => { f.run.caseId = randomUUID(); }, f => { f.run.planVersion = 2; }, f => { f.run.browserEntryReceipt = null; }, f => { f.run.browserEntryReceipt.sessionId = randomUUID(); }, f => { f.run.startedAt = f.at(4999); }, f => { f.rows.missionEvents[0].payload.caseKeys = ['other']; }]) {
    const f = fixture(); change(f); assert.equal(await project(reader(f.rows), f.scope, f.run), undefined);
  }
});
function reviewFunctions(db) {
  const start = reviews.indexOf('type Reader ='), end = reviews.indexOf('// Called within the same transaction');
  const assembly = compile(reviews.slice(start, end), { db, and, eq, inArray, testRuns: schema.testRuns, testCaptures: schema.testCaptures, workspaceItems: schema.workspaceItems, browserReturnContext: project, runChecks, normalizeEvidenceProvenance, EVIDENCE_POLICY_VERSION, reviewRules, createError: e => Object.assign(new Error(e.statusMessage), e) }, 'buildReviewInput');
  const hashReview = compile(reviews.slice(reviews.indexOf('function canonicalReview'), reviews.indexOf('export function autoReviewEnabled')), { createHash, REVIEW_HASH_VERSION }, 'hashReview');
  return { assembly, hashReview };
}
test('actual review input builder includes context in canonical hash but not evidence or requirement coverage', async () => {
  const f = fixture(), db = reader(f.rows), { assembly, hashReview } = reviewFunctions(db);
  const input = await assembly(f.scope.workspaceId, f.run.id);
  assert.deepEqual(input.browserSessionContext, context); assert.deepEqual(input.evidence, []);
  assert.ok(input.ruleFindings.some(f => f.code === 'evidence_missing'));
  assert.deepEqual(input.requirements, runChecks(f.run.snapshot));
  const originalHash = hashReview(input); f.rows.missionEvents = [];
  const unknown = await assembly(f.scope.workspaceId, f.run.id); assert.equal(unknown.browserSessionContext, undefined); assert.notEqual(hashReview(unknown), originalHash);
  const result = { verdict: 'supported', summary: 'profile', findings: input.requirements.map(r => ({ requirementId: r.id, verdict: 'supported', explanation: 'human return', evidenceIds: [], suggestedNextStep: '', gap: null })) };
  assert.throws(() => validateAssessment(input, result), /needs evidence/);
});
test('dispatch prompt uses exact projected context and never calls it login evidence', async () => {
  const start = controller.indexOf('    const sessionContext = await browserReturnContext('), end = controller.indexOf('    await browserJobAction(', start);
  const build = compile(`async function build(db, mission, attempt, task, caseKeys) { ${controller.slice(start, end)} return prompt; }`, { browserReturnContext: project }, 'build');
  const f = fixture(), prompt = await build(reader(f.rows), f.rows.missions[0], f.rows.missionAttempts[1], f.rows.missionTasks[0], f.rows.missionTasks[0].spec.caseKeys);
  assert.match(prompt, /En människa har återlämnat/); assert.match(prompt, /autentiseringsstatus är okänd/); assert.match(prompt, /inte bevis på lyckad inloggning/);
  f.rows.missionEvents = []; const generic = await build(reader(f.rows), f.rows.missions[0], f.rows.missionAttempts[1], f.rows.missionTasks[0], []);
  assert.doesNotMatch(generic, /En människa har återlämnat/); assert.match(generic, /bevisar inte ett rent webbläsarläge/);
});
test('strict optional context cannot claim auth or leak private receipt fields', () => {
  assert.equal(REVIEWER_VERSION, '19'); assert.deepEqual(browserSessionContextSchema.parse(context), context);
  for (const extra of [{ priorAuthentication: 'authenticated' }, { sessionId: randomUUID() }, { cookie: 'secret' }, { evidenceId: 'receipt' }]) assert.equal(browserSessionContextSchema.safeParse({ ...context, ...extra }).success, false);
});
test('installed SDK transports unknown history and full explicit anonymous requirement without adding evidence', async () => {
  const f = fixture(), input = await reviewFunctions(reader(f.rows)).assembly(f.scope.workspaceId, f.run.id);
  input.requirements = [{ id: 'step-1', requirement: 'The profile requires sign-in from an anonymous session.' }];
  const saved = structuredClone(input), oldFetch = globalThis.fetch, oldKey = process.env.GRUNDEN_API_TOKEN; let request, calls = 0;
  process.env.GRUNDEN_API_TOKEN = 'synthetic';
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.grunden.ai/v1/chat/completions'); calls++; request = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: 'synthetic', object: 'chat.completion', created: 0, model: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ summary: 'Anonymous access is unknown.', findings: { 'step-1': { coverage: 'complete', parts: [{ text: 'No anonymous session observation.', evidenceIds: [], basis: 'state', relation: 'unresolved' }], suggestedNextStep: '', gap: { kind: 'environment_prerequisite', wantedEvidence: 'An independent observation in the required session state.', capability: 'none' } } } }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await assessResult(input, [], AbortSignal.timeout(5000)); assert.equal(result.verdict, 'needs_evidence'); assert.equal(calls, 1);
    const content = request.messages.at(-1).content;
    const wire = JSON.parse(typeof content === 'string' ? content : content[0].text);
    assert.deepEqual(wire.browserSessionContext, context); assert.deepEqual(wire.evidence, []); assert.equal(wire.requirements[0].requirement, input.requirements[0].requirement);
    assert.deepEqual(wire.reportedResult, saved.reportedResult); assert.equal(request.model, 'glm-5.3'); assert.equal(request.reasoning_effort, 'high');
    assert.match(request.messages[0].content, /inte oberoende underlag eller bevis på inloggning/);
    assert.deepEqual(input, saved);
    await assert.rejects(assessResult({ ...input, browserSessionContext: { ...context, priorAuthentication: 'authenticated' } }, [], AbortSignal.timeout(5000))); assert.equal(calls, 1);
  } finally { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.GRUNDEN_API_TOKEN; else process.env.GRUNDEN_API_TOKEN = oldKey; }
});

test('list freshness and controller lookup use the identical contextual review fingerprint', async () => {
  const f = fixture(), db = reader(f.rows);
  const code = reviews.slice(reviews.indexOf('function canonicalReview'), reviews.indexOf('export function autoReviewEnabled'))
    + reviews.slice(reviews.indexOf('type Reader ='), reviews.indexOf('// Called within the same transaction'))
    + reviews.slice(reviews.indexOf('export async function listAssessments'));
  const api = compile(code, { db, and, eq, inArray, desc: () => null, testRuns: schema.testRuns, testCaptures: schema.testCaptures, workspaceItems: schema.workspaceItems, jobs: schema.jobs, browserReturnContext: project, runChecks, normalizeEvidenceProvenance, EVIDENCE_POLICY_VERSION, reviewRules, createHash, REVIEW_HASH_VERSION, REVIEWER_VERSION, runtimeScope: () => f.scope.runtime,
    requireWorkspace: async (user, workspace) => { assert.equal(user, f.scope.userId); assert.equal(workspace, f.scope.workspaceId); },
    createError: e => Object.assign(new Error(e.statusMessage), e) }, '({buildReviewInput,hashReview,listAssessments,readCurrentRunAssessment})');
  const input = await api.buildReviewInput(f.scope.workspaceId, f.run.id), sourceHash = api.hashReview(input);
  f.rows.jobs.push({ id: randomUUID(), workspaceId: f.scope.workspaceId, runId: f.run.id, runtime: f.scope.runtime, reviewerVersion: REVIEWER_VERSION, model: 'fixture', input, sourceHash, inputHash: sourceHash, status: 'completed', createdAt: f.at(10000), finishedAt: f.at(11000), notification: 'recorded' });
  assert.equal((await api.listAssessments(f.scope.userId, f.scope.workspaceId))[0].stale, false);
  assert.equal((await api.readCurrentRunAssessment(f.scope.workspaceId, f.run.id)).id, f.rows.jobs[0].id);
  f.rows.missionEvents = [];
  assert.equal((await api.listAssessments(f.scope.userId, f.scope.workspaceId))[0].stale, true);
  assert.equal(await api.readCurrentRunAssessment(f.scope.workspaceId, f.run.id), undefined);
  assert.deepEqual(f.rows.jobs[0].input.browserSessionContext, context, 'Historical saved review stays unchanged');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { projectPreservedIris, auditPreservedIris, auditPreservedTraceBytes, requirePreservedTraceCoverage, PRESERVED_IRIS_PROTOCOL } from './helpers/evidence-preserved-iris.mjs';
import { EVIDENCE_PROTOCOL, validateEvidenceManifest, evidencePrompt, auditEvidenceCompletion, fingerprint } from './helpers/evidence-acceptance.mjs';

const callId = 'a10114a8-3c15-4771-83f2-010000000001';
const sha = b => createHash('sha256').update(b).digest('hex');
const options = { workspaceId: 'workspace', runtime: 'autonomy-test:history', userId: 'owner', reviewerVersion: '10' };
const provider = { providerCalls: 1, unknownCalls: 0, inputTokens: 12, outputTokens: 3, totalTokens: 15, cacheReadTokens: null, cacheWriteTokens: null, durationMs: 1 };
function fixture() {
  const markers = [`server:iris-model:start:${callId}`, `server:iris-model:usage:${JSON.stringify({ callId, inputTokens: 12, outputTokens: 3, cacheReadTokens: null, cacheWriteTokens: null, durationMs: 1 })}`];
  const raw = { id: 'attempt', mission_id: 'mission', kind: 'browser_tests', status: 'completed', runtime: options.runtime, dispatch_id: 'job', executor_resource_id: null,
    created_at: '2026-10-01T10:00:00Z', finished_at: '2026-10-01T10:02:00Z', usage: { tokens: 15 }, tool_call_ids: markers,
    workspace_id: 'workspace', user_id: 'owner', thread_id: 'thread', lifecycle: 'closed', job_id: 'job', job_runtime: options.runtime,
    job_thread_id: 'thread', session_id: 'actual-session', job_status: 'completed', job_user_id: 'owner', job_workspace_id: 'workspace' };
  const runs = ['one', 'two', 'three'].map((id, index) => ({ id, mission_attempt_id: 'attempt', runtime: options.runtime, plan_version: 1,
    started_at: `2026-10-01T10:00:${String(index * 20 + 1).padStart(2, '0')}Z`, finished_at: `2026-10-01T10:00:${String(index * 20 + 15).padStart(2, '0')}Z` }));
  const captures = runs.map(run => ({ id: `capture-row-${run.id}`, item_id: `capture-${run.id}`, run_id: run.id, version: 1, deleted_at: null, error: null,
    content: { kind: 'file', mime: 'application/json' }, provenance: { origin: 'tool', sourceType: 'test', sourceId: run.id, producer: 'browser-action', sha256: 'a'.repeat(64) } }));
  const state = { preservedIris: projectPreservedIris([raw]), reviews: [{ id: 'review', run_id: 'one', status: 'completed', reviewer_version: '9', model: 'actual-model',
    input_hash: 'b'.repeat(64), source_hash: 'c'.repeat(64), assessment: { verdict: 'needs_evidence' }, input: { workspaceId: 'workspace', runId: 'one', planVersion: 1,
      evidence: [{ readStatus: 'read', itemId: 'capture-one', version: 1, sha256: 'a'.repeat(64) }] } }],
  attempts: [{ id: 'review-attempt', mission_id: 'mission', kind: 'review', status: 'completed', reviewCalls: [{ reviewId: 'review', providerCalls: 1 }], usage: { provider } }] };
  return { raw, state, seed: { runs, captures }, options };
}

test('v4 is explicitly historical REP05 only; old protocols and saved-report prompt remain unchanged', () => {
  const base = { protocol: PRESERVED_IRIS_PROTOCOL, catalogVersion: '2026-10-05', taskId: 'REP-05', variant: 'historical-review-gap', preparation: 'preserved-actual',
    runtime: options.runtime, sourceHash: 'd'.repeat(64), model: 'glm-5.3-flash', reasoning: 'low', observationSeconds: 1500,
    trials: [{ workspaceId: 'workspace', accountFile: 'private.json', selection: [{ type: 'test', id: 'one', label: 'Startsidan i går' }], seedHash: 'e'.repeat(64), originalExecutionHash: 'f'.repeat(64), originArtifacts: [] }] };
  validateEvidenceManifest(base, { execute: true });
  for (const patch of [{ taskId: 'REP-06' }, { variant: 'normal' }, { preparation: 'synthetic-golden' }]) assert.throws(() => validateEvidenceManifest({ ...base, ...patch }));
  const unlocked = structuredClone(base); delete unlocked.trials[0].originalExecutionHash;
  validateEvidenceManifest(unlocked); assert.throws(() => validateEvidenceManifest(unlocked, { execute: true }), /prelocked original execution/);
  assert.throws(() => validateEvidenceManifest({ ...base, protocol: 'syna-evidence-acceptance-v3' }), /unknown field/);
  assert.equal(EVIDENCE_PROTOCOL, 'syna-evidence-acceptance-v3');
  assert.equal(evidencePrompt(base, base.trials[0]), evidencePrompt({ ...base, protocol: 'syna-evidence-acceptance-v3' }, base.trials[0]));
});

test('exact nullable historical physical ID binds only through original dispatch/job/session; meters counted per attempt', () => {
  const f = fixture(), proof = auditPreservedIris(f.state, f.seed, options);
  assert.equal(proof.bindings.length, 3); assert.equal(proof.attempts.length, 1); assert.equal(proof.attempts[0].modelUsage.tokens, 15);
  f.state.preservedIris[0].executor_resource_id = 'job'; auditPreservedIris(f.state, f.seed, options);
  assert.doesNotMatch(JSON.stringify(f.state.preservedIris), /server:iris-model:|a10114a8/);
});

for (const [field, value] of Object.entries({ runtime: 'autonomy-test:foreign', workspace_id: 'foreign', user_id: 'foreign', job_workspace_id: 'foreign', job_user_id: 'foreign', job_runtime: 'autonomy-test:foreign',
  job_thread_id: 'foreign', job_id: 'foreign', dispatch_id: 'foreign', session_id: null, executor_resource_id: 'different-physical-id', lifecycle: 'active', job_status: 'running', kind: 'planning' })) {
  test(`historical identity never falls back across ${field}`, () => {
    const f = fixture(); f.state.preservedIris[0][field] = value; assert.throws(() => auditPreservedIris(f.state, f.seed, options));
  });
}

test('missing, conflicting or aggregate-only model receipts cannot be upgraded into actual Iris evidence', () => {
  for (const change of [raw => raw.tool_call_ids = [], raw => raw.tool_call_ids.push('server:iris-model:usage:{}'), raw => raw.usage.tokens = 1,
    raw => raw.usage.provider = { ...provider, providerCalls: 2 }, raw => raw.usage.provider = null]) {
    const f = fixture(); change(f.raw); f.state.preservedIris = projectPreservedIris([f.raw]); assert.throws(() => auditPreservedIris(f.state, f.seed, options));
  }
  const f = fixture(); assert.throws(() => projectPreservedIris([f.raw, f.raw]), /Duplicate/);
});

test('a known physical receipt plus unknown call keeps the total unknown, never normalized to zero', () => {
  const f = fixture(); f.raw.tool_call_ids.push('server:iris-model:start:a10114a8-3c15-4771-83f2-010000000002'); f.raw.usage.tokens = null;
  f.state.preservedIris = projectPreservedIris([f.raw]); const proof = auditPreservedIris(f.state, f.seed, options);
  assert.equal(proof.attempts[0].modelUsage.tokens, null); assert.equal(proof.attempts[0].modelUsage.unknownCalls, 1);
  f.state.preservedIris[0].usage.tokens = 0; assert.throws(() => auditPreservedIris(f.state, f.seed, options));
});

test('historical review needs its own physical call and actually read original evidence', () => {
  for (const change of [f => f.state.attempts[0].reviewCalls = [], f => f.state.attempts[0].mission_id = 'other',
    f => f.state.reviews[0].input.runId = 'different', f => f.state.reviews[0].input.planVersion = 2,
    f => f.state.reviews[0].input.evidence[0].readStatus = 'metadata_only', f => f.state.reviews[0].input.evidence[0].sha256 = 'f'.repeat(64),
    f => f.state.reviews[0].reviewer_version = options.reviewerVersion, f => f.state.reviews[0].assessment.verdict = 'supported']) {
    const f = fixture(); change(f); assert.throws(() => auditPreservedIris(f.state, f.seed, options), /Historical incomplete review/);
  }
});

function traceFixture() {
  const f = fixture(), proof = auditPreservedIris(f.state, f.seed, options), capture = f.seed.captures[0];
  const trace = { version: 1, browserJobId: 'job', execution: { attemptId: 'attempt', dispatchId: 'job' }, action: 'open',
    startedAt: '2026-10-01T10:00:02Z', finishedAt: '2026-10-01T10:00:04Z', toUrl: 'https://example.test/', httpStatus: 200 };
  const bytes = Buffer.from(JSON.stringify(trace)); capture.provenance.sha256 = sha(bytes);
  return { ...f, proof, capture, trace, bytes };
}

test('byte-read trace binds original capture to exact attempt/job and interval, no invented trace runId', () => {
  const f = traceFixture(), receipt = auditPreservedTraceBytes(f.bytes, f.capture, f.seed, f.proof);
  assert.equal(receipt.runId, 'one'); assert.throws(() => requirePreservedTraceCoverage(f.seed, [receipt]), /lacks/);
  requirePreservedTraceCoverage(f.seed, f.seed.runs.map(run => ({ runId: run.id })));
});

test('wrong run, attempt, dispatch, bytes, source origin or time never pass historical trace binding', () => {
  for (const mutate of [f => f.trace.execution.attemptId = 'other', f => f.trace.execution.dispatchId = 'other', f => f.trace.browserJobId = 'other',
    f => f.trace.startedAt = '2026-10-01T09:00:00Z', f => f.trace.finishedAt = '2026-10-01T10:02:00Z',
    f => f.capture.provenance.origin = 'agent', f => f.capture.provenance.sourceId = 'two', f => f.capture.run_id = 'two']) {
    const f = traceFixture(); mutate(f); const bytes = Buffer.from(JSON.stringify(f.trace)); f.capture.provenance.sha256 = sha(bytes);
    assert.throws(() => auditPreservedTraceBytes(bytes, f.capture, f.seed, f.proof));
  }
  const f = traceFixture(); assert.throws(() => auditPreservedTraceBytes(Buffer.from('{}'), f.capture, f.seed, f.proof), /bytes changed/);
});

function reportFixture() {
  const f = fixture(), before = { ...f.state, ...f.seed, missions: [{ id: 'mission', lifecycle: 'closed' }], tasks: [], jobs: [], reports: [], claims: [], events: [], items: [], repositories: [], setups: [] };
  before.runs.forEach((run, index) => { run.result = { outcome: index === 1 ? 'failed' : 'passed' }; run.snapshot = { type: 'browser', title: 'Original' }; });
  const after = structuredClone(before), selection = before.runs.map(run => ({ type: 'test', id: run.id }));
  after.missions.push({ id: 'report-mission', lifecycle: 'closed', intent: 'report_only', thread_id: 'new-thread' });
  after.tasks.push({ id: 'report-task', mission_id: 'report-mission', spec: { kind: 'report' } });
  after.items.push({ id: 'report-item', deleted_at: null });
  const sources = before.runs.map(run => ({ sourceType: 'test', sourceId: run.id, reportedOutcome: run.result.outcome === 'failed' ? 'partial' : 'achieved',
    evidence: before.captures.filter(c => c.run_id === run.id).map(c => ({ id: 'item:' + c.item_id, itemId: c.item_id, version: c.version,
      hash: fingerprint({ content: c.content, provenance: c.provenance, evidencePolicyVersion: 2 }), evidencePolicyVersion: 2, origin: 'tool', provenance: c.provenance })) }));
  after.reports.push({ id: 'report', mission_id: 'report-mission', status: 'completed', item_id: 'report-item', input: { tasks: [{ sources }] },
    read_receipts: sources.flatMap(s => s.evidence.map(e => ({ id: e.id, hash: e.hash, version: e.version, digest: e.provenance.sha256 }))),
    document: { partial: true, findings: [{ verdict: 'needs_evidence' }], evidence: sources.flatMap(s => s.evidence.map(e => ({ id: e.id, itemId: e.itemId, version: e.version, read: true }))) } });
  return { before, after, selection, manifest: { protocol: PRESERVED_IRIS_PROTOCOL, taskId: 'REP-05', variant: 'historical-review-gap' } };
}

test('v4 completion still needs partial gap, each original actually read, and unchanged historical receipts', () => {
  const f = reportFixture();
  const audit = () => auditEvidenceCompletion(f.manifest, { selection: f.selection }, f.before, f.after, 'new-thread');
  assert.equal(audit().historicalSourceReads.length, 3);
  f.after.reports[0].document.partial = false; assert.throws(audit, /partial/);
});

test('v4 rejects missing or metadata-only source bytes, changed old review and ledger, and lost negative original', () => {
  for (const change of [f => f.after.reports[0].read_receipts.pop(), f => f.after.reports[0].read_receipts[0].limited = true,
    f => f.after.reports[0].document.evidence[0].read = false, f => f.after.reviews[0].assessment.verdict = 'supported',
    f => f.after.preservedIris[0].executor_resource_id = 'changed', f => f.after.reports[0].input.tasks[0].sources[1].reportedOutcome = 'achieved']) {
    const f = reportFixture(); change(f); assert.throws(() => auditEvidenceCompletion(f.manifest, { selection: f.selection }, f.before, f.after, 'new-thread'), /full exact original read|Original .* changed|negative result/);
  }
});

test('prelocked execution fingerprint includes actual old assessment and review-provider receipts', () => {
   const f = fixture(), initial = auditPreservedIris(f.state, f.seed, options), initialHash = fingerprint(initial);
   f.state.reviews[0].assessment.summary = 'Changed old review';
   assert.notEqual(fingerprint(auditPreservedIris(f.state, f.seed, options)), initialHash);
   const g = fixture(); g.state.attempts[0].usage.provider.durationMs++;
   assert.notEqual(fingerprint(auditPreservedIris(g.state, g.seed, options)), initialHash);
 });

test('prelocked original execution binds the entire sanitized SQL receipt and terminal identities', () => {
  const base = fixture(), originalHash = fingerprint(auditPreservedIris(base.state, base.seed, options));
  for (const mutate of [row => row.status = 'failed', row => row.job_status = 'failed', row => row.executor_resource_id = 'job',
    row => row.created_at = '2026-10-01T09:59:59Z', row => row.finished_at = '2026-10-01T10:02:01Z', row => row.usage.durationMs = 23]) {
    const f = fixture(); mutate(f.state.preservedIris[0]);
    assert.notEqual(fingerprint(auditPreservedIris(f.state, f.seed, options)), originalHash);
  }
});

test('new reviews coexist while every original completed review stays immutable', () => {
  const f = reportFixture(); f.after.reviews.push({ id: 'new-review', run_id: 'one', status: 'completed', reviewer_version: '10', assessment: { verdict: 'needs_evidence' } });
  assert.equal(auditEvidenceCompletion(f.manifest, { selection: f.selection }, f.before, f.after, 'new-thread').historicalSourceReads.length, 3);
  f.after.reviews[0].input.evidence[0].readStatus = 'metadata_only';
  assert.throws(() => auditEvidenceCompletion(f.manifest, { selection: f.selection }, f.before, f.after, 'new-thread'), /Original completed review changed/);
});

test('completion preserves each original physical review attempt while accepting a new attempt', () => {
  const f = reportFixture();
  f.after.attempts.push({ id: 'new-review-attempt', mission_id: 'report-mission', kind: 'review', status: 'completed', reviewCalls: [{ reviewId: 'new-review', providerCalls: 1 }], usage: { provider } });
  assert.equal(auditEvidenceCompletion(f.manifest, { selection: f.selection }, f.before, f.after, 'new-thread').historicalSourceReads.length, 3);
  for (const mutate of [row => row.status = 'failed', row => row.usage.provider.durationMs++, row => row.reviewCalls[0].providerCalls++]) {
    const g = reportFixture(); mutate(g.after.attempts[0]);
    assert.throws(() => auditEvidenceCompletion(g.manifest, { selection: g.selection }, g.before, g.after, 'new-thread'), /Original physical review attempt changed/);
  }
});

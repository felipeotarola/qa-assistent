import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
// Synthetic legacy test descriptions map to the current model wire only.
// These fixtures test contracts; they do not certify a real model's semantics.
const partsRow = ({ relation, text, evidenceIds, ...identity }) => ({ ...identity, text, coverage: 'complete', parts: [{ text, evidenceIds, relation, basis: 'other' }] });


const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { writeMissionReport } = await import('../agent/lib/mission-reporter.ts');
const { missionReportWriterContext, missionReportCheckSubjects } = await import('../shared/mission-report-context.ts');
const { validateReport, assembleReport, MISSION_REPORT_VERSION, REPORT_MAX_OUTPUT_TOKENS, hasCurrentReportPolicy } = await import('../shared/mission-report.ts');
const { missionReportOutput } = await import('../shared/mission-report-output.ts');
const { DELIVERY_POLICY_VERSION } = await import('../shared/mission-delivery.ts');
hooks.deregister();

function fixture() {
  const text = 'The Update action was performed; the displayed status remained Pending instead of becoming Complete.';
  const digest = createHash('sha256').update(text).digest('hex');
  const target = { environment: 'isolated unit', url: 'https://unit.example.test/', revision: 'fixed' };
  const source = { schemaVersion: 2, sourceType: 'test', sourceId: 'saved-run', sourceRevision: 'source-version', attemptId: 'saved-run', status: 'completed', target,
    startedAt: '2026-10-06T00:00:00Z', finishedAt: '2026-10-06T00:01:00Z',
    claims: [{ id: 'step-1', requirement: 'Click Update; status becomes Complete.', reportedStatus: 'mismatch', reportedActual: text }],
    evidence: [{ id: 'proof', kind: 'text', title: 'Saved action', hash: digest, origin: 'tool', evidencePolicyVersion: 2,
      observedAt: '2026-10-06T00:00:30Z', provenance: { version: 1, origin: 'tool', producer: 'browser-action', sourceType: 'test', sourceId: 'saved-run', observedAt: '2026-10-06T00:00:30Z', sha256: digest } }],
  };
  const snapshot = { schemaVersion: 2, missionId: 'mission', workspaceId: 'workspace', revision: 4, inputFingerprint: 'immutable-input',
    config: { title: 'Saved QA', goal: 'Summarize the saved action results.', scope: 'No new execution', target, caseKeys: [], criteria: [{ id: 'c', text: 'Review the exact saved result and state what it establishes.', delivery: { kind: 'source', sourceTypes: ['test'], sourceRefs: [{ type: 'test', id: 'saved-run' }] } }] },
    tasks: [{ id: 'task', title: 'Review saved result', actor: 'main', parentId: null, dependsOn: [], criterionIds: ['c'], sources: [source] }],
    delivery: { schemaVersion: DELIVERY_POLICY_VERSION, complete: true, criteria: [{ criterionId: 'c', complete: true, gaps: [] }], cases: [], gaps: [] },
    tests: [{ key: 'source:saved-run', runId: 'saved-run', originalOutcome: 'failed', status: 'failed' }], metrics: [], gaps: [],
  };
  return { snapshot, source, reads: new Map([['proof', { id: 'proof', text, digest }]]) };
}
const wire = (verdict, text, evidenceIds = ['proof']) => ({ checkAssessments: evidenceIds.length ? [partsRow({ checkRef: JSON.stringify(['test', 'saved-run', 'source-version', 'saved-run', 'step-1']), relation: verdict === 'contradicted' ? 'contradicts' : verdict === 'needs_evidence' ? 'unresolved' : 'supports', text, evidenceIds })] : [], findings: [{ criterionId: 'c', verdict, factualNotes: [] }] });
async function invoke(f, output) {
  const previousFetch = globalThis.fetch, previousKey = process.env.GRUNDEN_API_TOKEN, previousPacing = process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS;
  process.env.GRUNDEN_API_TOKEN = 'synthetic-report-judgement-key'; process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS = '0';
  const requests = [], readIds = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.grunden.ai/v1/chat/completions'); requests.push(JSON.parse(options.body));
    assert.equal(requests.length, 1, 'Only one synthetic transport call, no real network or provider retry');
    return new Response(JSON.stringify({ id: 'synthetic', created: 0, model: 'fixture', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 9 } }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await writeMissionReport(f.snapshot, async id => { readIds.push(id); assert.ok(f.reads.has(id)); return f.reads.get(id); }, AbortSignal.timeout(5000));
    return { result, requests, readIds };
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of [['GRUNDEN_API_TOKEN', previousKey], ['GRUNDEN_MIN_REQUEST_INTERVAL_MS', previousPacing]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
}

test('judgement context preserves the exact criterion and source claims without making a claim a replacement requirement', () => {
  const f = fixture(), before = JSON.stringify(f.snapshot);
  const note = { ...f.source, sourceType: 'material', sourceId: 'note', claims: undefined, evidence: [{ id: 'note-proof', kind: 'text', origin: 'agent', evidencePolicyVersion: 2, provenance: { version: 1, origin: 'agent', producer: 'agent-authored', observedAt: null } }] };
  f.snapshot.tasks[0].sources.push(note);
  const context = missionReportWriterContext(f.snapshot, new Set(['proof', 'note-proof']));
  assert.deepEqual(context.criteria, f.snapshot.config.criteria);
  assert.equal(context.judgementContext.verdictSubject, 'original_criterion');
  assert.equal(context.judgementContext.sourceClaimsRole, 'quoted_claims_not_replacement_requirements');
  assert.equal(context.judgementContext.unperformedAction, 'unknown_product_outcome_not_contradiction');
  assert.equal(context.judgementContext.correctlyReportedFailure, 'may_support_a_complete_report');
  assert.deepEqual(context.sources[0].reportedClaims.items, f.source.claims);
  assert.equal(context.sources[1].evidence[0].origin, 'agent');
  assert.equal(context.sources[1].reportedClaims, undefined);
  assert.equal(context.sources[1].assessment, undefined);
  assert.equal(context.sources[1].unreadEvidenceCount, undefined);
  f.snapshot.tasks[0].sources.pop(); assert.equal(JSON.stringify(f.snapshot), before);
});

test('installed writer SDK assesses the full original check, not a narrower truthful actual; historical output is not remapped', async () => {
  const f = fixture(), requirement = 'The named controls are visible and usable.';
  Object.assign(f.source.claims[0], { requirement, reportedStatus: 'verified', reportedActual: 'Visible controls returned refs.' });
  f.snapshot.config.goal = requirement; f.snapshot.config.criteria[0].text = requirement;
  const text = 'Independent open observation: named controls visible; no actionability observation recorded.';
  const digest = createHash('sha256').update(text).digest('hex');
  f.source.evidence[0].hash = digest; f.source.evidence[0].provenance.sha256 = digest;
  f.reads.set('proof', { id: 'proof', text, digest });
  const original = structuredClone(f.snapshot), expected = wire('needs_evidence', 'Presence is supported; usability is not established by these bytes.');
  const { result, requests, readIds } = await invoke(f, expected);
  const context = JSON.parse(requests[0].messages.at(-1).content[0].text);
  assert.deepEqual(context.sources[0].reportedClaims.items, original.tasks[0].sources[0].claims);
  assert.deepEqual(context.criteria, original.config.criteria);
  const draft = validateReport(f.snapshot, result.draft, new Set(readIds), f.reads);
  const document = assembleReport(f.snapshot, draft, new Set(readIds), f.reads);
  assert.equal(document.findings[0].observations[0].subject.relation, 'unresolved');
  assert.equal(document.findings[0].observations[0].subject.requirement, requirement);
  assert.equal(document.partial, true); assert.deepEqual(f.snapshot, original);
  assert.equal(requests.length, 1); assert.equal(requests[0].model, 'glm-5.3'); assert.equal(requests[0].max_tokens, 16000); assert.equal(requests[0].reasoning_effort, 'high');
  const schema = requests[0].response_format.json_schema.schema;
  assert.match(JSON.stringify(schema), /requirement\/status\/actual/);
  // Choosing unresolved is mocked. These assertions demonstrate exact scope,
  // transport and output preservation, not a new real semantic judgement.
});

test('installed SDK receives the general three-way relation table and full bytes; a verified negative remains complete', async () => {
  const f = fixture(), before = JSON.stringify(f.snapshot), expected = wire('supported', f.reads.get('proof').text);
  const { result, requests, readIds } = await invoke(f, expected);
  const request = requests[0], system = request.messages.filter(message => message.role === 'system').map(message => message.content).join(' ');
  assert.match(system, /Bedöm verdict mot originalkriteriet/);
  assert.match(system, /Okänt är varken sant eller falskt/);
  assert.match(system, /Handlingen utfördes inte eller beteendet verifierades inte/);
  assert.match(system, /En faktiskt belagd utebliven handling kan motsäga/);
  assert.match(system, /Enbart saknat eller otillräckligt underlag är fortfarande obestyrkt, även när påståendet säger verifierat/);
  assert.match(system, /Om supported inte är tillåtet får contradicted inte användas som ersättning/);
  assert.match(system, /Ett ursprungligt krav på verifierat produktbeteende/);
  const parts = request.messages.at(-1).content.filter(part => part.type === 'text').map(part => part.text);
  const context = JSON.parse(parts[0]); assert.deepEqual(context.criteria, f.snapshot.config.criteria);
  assert.equal(context.judgementContext.verdictSubject, 'original_criterion');
  assert.ok(parts.some(part => { try { return JSON.parse(part).text === f.reads.get('proof').text; } catch { return false; } }));
  assert.deepEqual(readIds, ['proof']); assert.equal(result.usage.provider.providerCalls, 1); assert.equal(result.usage.totalTokens, 39);
  const validated = validateReport(f.snapshot, result.draft, new Set(readIds), f.reads);
  const document = assembleReport(f.snapshot, validated, new Set(readIds), f.reads);
  assert.equal(document.partial, false); assert.equal(document.tests[0].originalOutcome, 'failed'); assert.equal(document.tests[0].status, 'failed');
  assert.equal(document.findings[0].observations[0].text, expected.checkAssessments[0].parts[0].text);
  assert.equal(JSON.stringify(f.snapshot), before);
});

test('a genuine contrary action observation may remain contradicted; no prompt rule silently remaps the model result', async () => {
  const f = fixture();
  f.snapshot.config.goal = 'Assess the assertion that the saved Update action changed Pending to Complete.';
  f.snapshot.config.criteria[0].text = 'The recorded Update action changed the status from Pending to Complete.';
  f.source.claims[0].reportedStatus = 'verified'; f.source.claims[0].reportedActual = 'The performed Update action changed the status to Complete.';
  const expected = wire('contradicted', 'The saved action stayed Pending, contrary to the claim that this action changed it to Complete.');
  const { result, readIds } = await invoke(f, expected);
  const validated = validateReport(f.snapshot, result.draft, new Set(readIds), f.reads);
  assert.equal(validated.findings[0].verdict, 'contradicted');
  assert.equal(validated.findings[0].observations[0].text, expected.checkAssessments[0].parts[0].text);
});

test('an explicit verification requirement with no independent observation remains unresolved and unchanged', () => {
  const f = fixture(); f.snapshot.config.goal = 'Determine whether the alert was delivered.';
  f.snapshot.config.criteria[0].text = 'Verify the alert was delivered to the recipient.';
  f.reads.clear(); const before = JSON.stringify(f.snapshot), output = missionReportOutput(f.snapshot, f.reads);
  assert.deepEqual(output.criteria[0].allowedVerdicts, ['needs_evidence']);
  assert.ok(output.schema.safeParse(wire('needs_evidence', '', [])).success);
  for (const verdict of ['supported', 'contradicted']) assert.equal(output.schema.safeParse(wire(verdict, '', [])).success, false);
  assert.deepEqual(missionReportWriterContext(f.snapshot, new Set()).criteria, f.snapshot.config.criteria);
  assert.equal(JSON.stringify(f.snapshot), before);
});

test('the changed writer judgement contract cannot reuse an old queued report policy; old document bytes are not migrated', () => {
  const f = fixture(); assert.match(MISSION_REPORT_VERSION, /:judgement-8:regression-1:task-history-2:reviewed-checks-2:model-glm-5\.3:output-16000$/);
  assert.equal(REPORT_MAX_OUTPUT_TOKENS, 16000);
  assert.ok(hasCurrentReportPolicy(MISSION_REPORT_VERSION, f.snapshot));
  assert.equal(hasCurrentReportPolicy(MISSION_REPORT_VERSION.replace(':output-16000', ''), f.snapshot), false);
  assert.equal(hasCurrentReportPolicy(MISSION_REPORT_VERSION.replace(':output-16000', ':output-10000'), f.snapshot), false);
  assert.equal(hasCurrentReportPolicy(MISSION_REPORT_VERSION.replace(':reviewed-checks-2', ':reviewed-checks-1'), f.snapshot), false);
  assert.equal(hasCurrentReportPolicy(MISSION_REPORT_VERSION.replace(':model-glm-5.3', ''), f.snapshot), false);
  assert.equal(hasCurrentReportPolicy(MISSION_REPORT_VERSION.replace(':model-glm-5.3', ':model-glm-5.3-flash'), f.snapshot), false);
  assert.equal(hasCurrentReportPolicy(MISSION_REPORT_VERSION.replace(':judgement-8', ':judgement-7'), f.snapshot), false);
  assert.equal(hasCurrentReportPolicy(MISSION_REPORT_VERSION.replace(':judgement-8', ''), f.snapshot), false);
});

test('assessment metadata reaches the installed writer SDK without making an uncited saved finding reusable', async () => {
  const f = fixture();
  f.source.assessment = { status: 'completed', stale: false, reviewerVersion: '18', id: 'review', finishedAt: '2026-10-06T00:02:00Z',
    verdict: 'needs_evidence', summary: 'PRIVATE_REVIEW_SUMMARY', findings: [{ requirementId: 'step-1', verdict: 'needs_evidence', evidenceIds: [],
      explanation: 'PRIVATE_FINDING_TEXT', suggestedNextStep: 'PRIVATE_NEXT_STEP', gap: { kind: 'unverified_step', capability: 'none', wantedEvidence: 'PRIVATE_GAP_TEXT' } }] };
  const before = structuredClone(f.snapshot), output = missionReportOutput(f.snapshot, f.reads);
  assert.equal(output.savedChecks.length, 0); assert.equal(output.requiredCheckRefs.length, 1);
  const { result, requests, readIds } = await invoke(f, wire('needs_evidence', 'The current evidence leaves the reported check unresolved.'));
  const context = JSON.parse(requests[0].messages.at(-1).content[0].text);
  assert.deepEqual(context.sources[0].assessmentMetadata, {
    role: 'saved_assessment_metadata_only_not_evidence_or_reuse_authority', reuseAuthority: 'savedChecks_only',
    status: 'completed', stale: false, reviewerVersion: '18', checks: [{ checkId: 'step-1', verdict: 'needs_evidence' }],
  });
  assert.deepEqual(context.savedChecks, []); assert.deepEqual(context.requiredCheckRefs, output.requiredCheckRefs);
  assert.equal(JSON.stringify(context).includes('PRIVATE_'), false);
  assert.deepEqual(context.sources[0].reportedClaims.items, before.tasks[0].sources[0].claims);
  const validated = validateReport(f.snapshot, result.draft, new Set(readIds), f.reads);
  assert.equal(validated.findings[0].verdict, 'needs_evidence');
  assert.equal(assembleReport(f.snapshot, validated, new Set(readIds), f.reads).partial, true);
  assert.equal(requests.length, 1); assert.equal(requests[0].max_tokens, 16000); assert.equal(requests[0].reasoning_effort, 'high');
  assert.deepEqual(f.snapshot, before);
});

test('assessment metadata cannot alter source identity, grant evidence or upgrade failed stale unknown reviews', () => {
  const f = fixture(), readIds = new Set(['proof']);
  const subjects = missionReportCheckSubjects(f.snapshot, readIds);
  f.source.evidence[0].origin = 'agent';
  f.source.evidence[0].provenance = { version: 1, origin: 'agent', producer: 'agent-authored', observedAt: f.source.evidence[0].observedAt };
  const nonIndependentSubjects = missionReportCheckSubjects(f.snapshot, readIds);
  for (const status of ['queued', 'running', 'failed', 'completed', undefined]) {
    f.source.assessment = { status, stale: true, reviewerVersion: 'old', verdict: 'supported', summary: 'PRIVATE_SUMMARY',
      findings: [{ requirementId: 'step-1', verdict: 'supported', evidenceIds: ['proof'], explanation: 'PRIVATE_EXPLANATION', suggestedNextStep: '', gap: null }] };
    const before = structuredClone(f.snapshot), context = missionReportWriterContext(f.snapshot, readIds);
    assert.equal(context.sources[0].assessmentMetadata.status, status ?? null);
    assert.equal(context.sources[0].assessmentMetadata.stale, true); assert.equal(context.sources[0].assessmentMetadata.reviewerVersion, 'old');
    assert.equal(JSON.stringify(context).includes('PRIVATE_'), false);
    assert.deepEqual(missionReportCheckSubjects(f.snapshot, readIds), nonIndependentSubjects);
    const output = missionReportOutput(f.snapshot, f.reads);
    assert.deepEqual(output.savedChecks, []); assert.deepEqual(output.criteria[0].allowedVerdicts, ['needs_evidence']);
    assert.equal(output.schema.safeParse(wire('supported', 'A saved label is not independent proof.')).success, false);
    assert.equal(missionReportWriterContext(f.snapshot, new Set()).sources.length, 0);
    assert.deepEqual(f.snapshot, before);
  }
  assert.notDeepEqual(subjects, nonIndependentSubjects, 'The original provenance identity still detects a real source change');
});

test('installed SDK preserves destination-only and healthy-content claims over identical observed 404 bytes without a verdict rewrite', async () => {
  // Synthetic provider responses verify transport and validation, not whether a
  // live model obeys the distinction. The preserved actual regression needs a
  // separately authorized model replay before claiming improved judgement.
  const text = JSON.stringify({ action: 'click', fromUrl: 'https://unit.example.test/', toUrl: 'https://unit.example.test/archive', httpStatus: 404, observation: { text: 'Page unavailable' } });
  const cases = [
    { requirement: 'The Archive link leads to /archive.', reportedActual: 'The click reached /archive. The page returned 404; page health is outside this destination-only claim.',
      verdict: 'supported', observation: 'The observed click reached the claimed /archive destination. Its 404 is a separate negative observation, not a contrary destination.' },
    { requirement: 'The Archive link leads to /archive with working non-error content.', reportedActual: 'The click reached /archive and the page displayed working non-error content.',
      verdict: 'contradicted', observation: 'The observed 404 and Page unavailable text contradict the specific claim of working non-error content.' },
  ];
  const contexts = [];
  for (const c of cases) {
    const f = fixture();
    Object.assign(f.source.claims[0], { requirement: c.requirement, reportedActual: c.reportedActual, reportedStatus: 'verified' });
    f.snapshot.config.goal = 'Assess exactly the selected saved claim.';
    f.snapshot.config.criteria[0].text = c.requirement;
    const digest = createHash('sha256').update(text).digest('hex');
    f.source.evidence[0].hash = digest; f.source.evidence[0].provenance.sha256 = digest;
    f.reads.set('proof', { id: 'proof', text, digest });
    const original = JSON.stringify(f.snapshot), expected = wire(c.verdict, c.observation);
    const { result, requests, readIds } = await invoke(f, expected);
    const parts = requests[0].messages.at(-1).content.filter(part => part.type === 'text').map(part => part.text);
    const context = JSON.parse(parts[0]); contexts.push(context);
    assert.deepEqual(context.sources[0].reportedClaims.items, f.source.claims);
    assert.deepEqual(context.criteria, f.snapshot.config.criteria);
    assert.deepEqual(context, { ...missionReportWriterContext(f.snapshot, new Set(readIds)), readObservations: context.readObservations, findingConstraints: context.findingConstraints, requiredCheckRefs: context.requiredCheckRefs, savedChecks: [], checkTextBudget: 240, factualTextBudget: 4000 });
    assert.ok(parts.some(part => { try { const value = JSON.parse(part); return value.id === 'proof' && value.text === text && value.digest === digest; } catch { return false; } }));
    const system = requests[0].messages.filter(message => message.role === 'system').map(message => message.content).join(' ');
    assert.match(system, /requirement, reportedStatus och reportedActual tillsammans/);
    assert.match(system, /reportedStatus=verified är agentens bedömning av just detta krav/);
    const validated = validateReport(f.snapshot, result.draft, new Set(readIds), f.reads);
    assert.equal(validated.findings[0].verdict, c.verdict);
    assert.equal(validated.findings[0].observations[0].text, c.observation);
    assert.equal(JSON.stringify(f.snapshot), original);
  }
  assert.deepEqual(contexts[0].sources[0].evidence, contexts[1].sources[0].evidence);
  assert.notDeepEqual(contexts[0].sources[0].reportedClaims.items, contexts[1].sources[0].reportedClaims.items);
});


test('writer keeps bounded allowance and admission denial before any provider call', async () => {
  const f = fixture(), before = structuredClone(f.snapshot);
  const previousFetch = globalThis.fetch, previousKey = process.env.GRUNDEN_API_TOKEN, previousPacing = process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS;
  process.env.GRUNDEN_API_TOKEN = 'synthetic-report-output-limit'; process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS = '0';
  let calls = 0, reads = 0, admissions = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected provider transport'); };
  try {
    await assert.rejects(writeMissionReport(f.snapshot, async id => { reads++; return f.reads.get(id); }, AbortSignal.timeout(5000), { maxTokens: 0 }), /positive bounded model allowance/);
    assert.equal(reads, 0); assert.equal(calls, 0);
    await assert.rejects(writeMissionReport(f.snapshot, async id => { reads++; return f.reads.get(id); }, AbortSignal.timeout(5000), { maxTokens: 100000, beforeModel: async () => { admissions++; throw new Error('Exact mandate revoked'); } }), /Exact mandate revoked/);
    assert.equal(admissions, 1); assert.equal(reads, 0); assert.equal(calls, 0); assert.deepEqual(f.snapshot, before);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of [['GRUNDEN_API_TOKEN', previousKey], ['GRUNDEN_MIN_REQUEST_INTERVAL_MS', previousPacing]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReport, assembleReport, independentMissionEvidence, MISSION_REPORT_VERSION } from '../shared/mission-report.ts';
import { validateAssessment, reviewRules, assessmentWithoutEvidence, REVIEWER_VERSION } from '../shared/result-assessment.ts';
import { sharedReportDocument } from '../shared/report-sharing.ts';
import { EVIDENCE_RULES_VERSION, evidenceApplicability } from '../shared/evidence-rules.ts';
import { DELIVERY_POLICY_VERSION } from '../shared/mission-delivery.ts';

const time = '2026-10-05T10:00:30Z';
const digest = 'a'.repeat(64);
const reads = new Map([['proof', { id: 'proof', digest }]]);
const target = { environment: 'test', url: 'https://example.com', revision: 'abc' };
const proof = () => ({
  id: 'proof', itemId: 'item', version: 1, title: 'Screenshot', kind: 'image', hash: 'source-hash', excerpt: '', url: target.url,
  origin: 'tool', evidencePolicyVersion: 2, provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: 'run-a', observedAt: time, sha256: digest },
  observedAt: time, unavailable: false,
});
const reportFixture = () => {
  const source = { schemaVersion: 2, sourceType: 'test', sourceId: 'run-a', target, status: 'completed', evidence: [proof()], startedAt: '2026-10-05T10:00:00Z', finishedAt: '2026-10-05T10:01:00Z' };
  const snapshot = { schemaVersion: 2, missionId: 'mission', workspaceId: 'workspace', revision: 1, capturedAt: time, status: 'closed', config: { title: 'Mission', goal: 'Verify navigation', scope: '', target, criteria: [{ id: 'navigation', text: 'Navigation works' }] }, tasks: [{ id: 'task', title: 'Navigate', actor: 'browser', criterionIds: ['navigation'], parentId: null, dependsOn: [], sources: [source] }], tests: [], metrics: [], gaps: [] };
  const draft = { summary: 'Navigation checked', findings: [{ criterionId: 'navigation', verdict: 'supported', conclusion: 'Navigation works', evidenceIds: ['proof'], nextStep: '' }], limitations: [] };
  snapshot.delivery = { schemaVersion: DELIVERY_POLICY_VERSION, complete: true, criteria: [{ criterionId: 'navigation', complete: true, gaps: [] }], cases: [], gaps: [] };
  snapshot.config.criteria[0].delivery = { kind: 'source', sourceTypes: ['test'] };
  return { snapshot, source, draft, evidence: source.evidence[0] };
};
const reviewFixture = () => {
  const evidence = { ...proof(), runId: 'run-a', mime: 'image/png', size: 4, blobPath: 'private/file', captureId: 'capture', action: 'click', error: null, sha256: digest, readStatus: 'read' };
  const input = { schemaVersion: 2, runId: 'run-a', workspaceId: 'workspace', planVersion: 1, target, environment: 'test', startedAt: '2026-10-05T10:00:00Z', finishedAt: '2026-10-05T10:01:00Z', requirements: [{ id: 'navigation', requirement: 'Navigation works' }], reportedResult: { outcome: 'passed', actual: 'Navigation worked', unverified: '', observations: [], evidenceItemIds: ['item'], checks: [{ id: 'navigation', status: 'verified', actual: 'Clicked' }] }, evidence: [evidence], ruleFindings: [] };
  const assessment = { verdict: 'supported', summary: 'Navigation checked', findings: [{ requirementId: 'navigation', verdict: 'supported', explanation: 'Navigation works', evidenceIds: ['proof'], suggestedNextStep: '' }] };
  return { input, evidence, assessment };
};

test('both consumers accept current attested and read run-specific evidence', () => {
  const report = reportFixture();
  assert.equal(validateReport(report.snapshot, report.draft, new Set(['proof']), reads).findings[0].verdict, 'supported');
  const review = reviewFixture();
  assert.equal(validateAssessment(review.input, review.assessment).verdict, 'supported');
});

test('legacy snapshots, absent policy and unknown/user/agent origins cannot be newly endorsed', () => {
  for (const mutate of [
    (e, container) => { container.schemaVersion = 1; },
    e => { delete e.evidencePolicyVersion; },
    e => { e.provenance = null; },
    e => { e.origin = 'source'; },
    e => { e.origin = 'agent'; e.provenance = { version: 1, origin: 'agent', producer: 'agent-authored', observedAt: null }; },
    e => { e.origin = 'user'; e.provenance = { version: 1, origin: 'user', producer: 'user-authored', observedAt: null }; },
    e => { e.provenance.producer = 'invented-tool'; },
  ]) {
    const report = reportFixture(); mutate(report.evidence, report.snapshot);
    assert.throws(() => validateReport(report.snapshot, report.draft, new Set(['proof']), reads), /independent/);
    // Historical reports still render without rewriting their saved conclusions.
    // Historical persisted documents still project without re-running new assembly.
    const historical = { ...assembleReport(report.snapshot, report.draft, new Set()), summary: report.draft.summary, findings: structuredClone(report.draft.findings) };
    const shared = sharedReportDocument(historical, []);
    assert.equal(shared.summary, report.draft.summary); assert.equal(shared.findings[0].conclusion, report.draft.findings[0].conclusion);
    assert.equal(Object.hasOwn(shared.findings[0], 'observations'), false);
    const review = reviewFixture(); mutate(review.evidence, review.input);
    assert.throws(() => validateAssessment(review.input, review.assessment));
    assert.equal(assessmentWithoutEvidence(review.input).verdict, 'needs_evidence');
  }
});

test('failed or successful capture metadata never substitutes for screenshot proof', () => {
  for (const error of [null, 'Capture failed']) {
    const report = reportFixture(); report.evidence.provenance.producer = 'capture-metadata'; report.evidence.kind = 'observation'; report.evidence.excerpt = JSON.stringify({ error });
    assert.throws(() => validateReport(report.snapshot, report.draft, new Set(['proof']), reads), /independent/);
    const review = reviewFixture(); review.evidence.provenance.producer = 'capture-metadata'; review.evidence.error = error;
    assert.equal(assessmentWithoutEvidence(review.input).verdict, 'needs_evidence');
    assert.throws(() => validateAssessment(review.input, review.assessment));
  }
});

test('contradictions need independent evidence too; narrative alone is uncertainty', () => {
  const report = reportFixture(); report.draft.findings[0].verdict = 'contradicted';
  assert.equal(validateReport(report.snapshot, report.draft, new Set(['proof']), reads).findings[0].verdict, 'contradicted');
  report.evidence.origin = 'agent'; report.evidence.provenance = { version: 1, origin: 'agent', producer: 'agent-authored', observedAt: null };
  assert.throws(() => validateReport(report.snapshot, report.draft, new Set(['proof']), reads), /independent/);
  const review = reviewFixture(); review.assessment.verdict = 'contradicted'; review.assessment.findings[0].verdict = 'contradicted';
  assert.equal(validateAssessment(review.input, review.assessment).verdict, 'contradicted');
  review.evidence.origin = 'agent'; review.evidence.provenance = report.evidence.provenance;
  assert.throws(() => validateAssessment(review.input, review.assessment), /independent/);
});

test('wrong run, time, target version, unread and stale evidence fail closed', () => {
  for (const mutate of [
    f => { f.evidence.provenance.sourceId = 'another-run'; },
    f => { f.evidence.observedAt = '2026-10-04T10:00:30Z'; },
    f => { f.evidence.unavailable = true; },
    f => { f.source.schemaVersion = 1; },
    f => { f.source.target = { ...target, revision: 'older' }; },
  ]) {
    const report = reportFixture(); mutate(report);
    assert.throws(() => validateReport(report.snapshot, report.draft, new Set(['proof']), reads), /independent/);
  }
  const report = reportFixture(); assert.throws(() => validateReport(report.snapshot, report.draft, new Set()), /Unread/);
  for (const mutate of [
    f => { f.evidence.provenance.sourceId = 'another-run'; },
    f => { f.evidence.runId = 'another-run'; },
    f => { f.evidence.observedAt = 'invalid'; },
    f => { f.evidence.readStatus = 'unavailable'; },
    f => { f.evidence.sha256 = 'b'.repeat(64); },
    f => { delete f.evidence.provenance.sha256; },
  ]) {
    const review = reviewFixture(); mutate(review);
    assert.throws(() => validateAssessment(review.input, review.assessment));
  }
});

test('one trusted citation cannot rescue a different finding backed only by an agent narrative', () => {
  const report = reportFixture();
  report.snapshot.config.criteria.push({ id: 'login', text: 'Login works' });
  report.snapshot.tasks[0].criterionIds.push('login');
  const narrative = { ...proof(), id: 'narrative', origin: 'agent', provenance: { version: 1, origin: 'agent', producer: 'agent-authored', observedAt: null } };
  report.source.evidence.push(narrative);
  report.draft.findings.push({ ...report.draft.findings[0], criterionId: 'login', evidenceIds: ['narrative'] });
  assert.throws(() => validateReport(report.snapshot, report.draft, new Set(['proof', 'narrative']), reads), /independent/);
  const review = reviewFixture();
  review.input.requirements.push({ id: 'login', requirement: 'Login works' });
  review.input.reportedResult.checks.push({ id: 'login', status: 'verified', actual: 'Logged in' });
  review.input.evidence.push({ ...review.evidence, ...narrative });
  review.assessment.findings.push({ ...review.assessment.findings[0], requirementId: 'login', evidenceIds: ['narrative'] });
  assert.throws(() => validateAssessment(review.input, review.assessment), /independent/);
  review.assessment.findings[0].verdict = 'needs_evidence'; review.assessment.verdict = 'needs_evidence';
  assert.throws(() => validateAssessment(review.input, review.assessment), /independent/);
});

test('a global or requirement uncertainty cannot be hidden by another needs-evidence finding', () => {
  const review = reviewFixture(); review.input.target = { ...target, revision: '' };
  review.input.requirements.push({ id: 'login', requirement: 'Login works' });
  review.assessment.verdict = 'needs_evidence'; review.assessment.findings.push({ requirementId: 'login', verdict: 'needs_evidence', explanation: 'No check', evidenceIds: [], suggestedNextStep: 'Check login' });
  review.input.ruleFindings = reviewRules(review.input);
  assert.throws(() => validateAssessment(review.input, review.assessment), /independent/);
});

test('research acquisition can support research while run binding is required for test claims', () => {
  const report = reportFixture(); report.evidence.kind = 'text'; report.evidence.provenance = { version: 1, origin: 'tool', producer: 'research-page', observedAt: time };
  assert.equal(independentMissionEvidence(report.source, report.evidence), false);
  report.source.sourceType = 'research'; report.source.target = null;
  assert.equal(independentMissionEvidence(report.source, report.evidence), true);
});

test('wrapping execution evidence in material or research cannot bypass its run scope', () => {
  for (const wrapper of ['material', 'research']) for (const [sourceType, producer] of [['test', 'test-capture'], ['setup', 'environment-probe'], ['repository', 'repository-runner']]) {
    const report = reportFixture();
    report.source.sourceType = wrapper; report.source.sourceId = 'item'; report.source.target = null;
    report.evidence.provenance = { ...report.evidence.provenance, sourceType, producer, sourceId: 'older-execution' };
    assert.equal(independentMissionEvidence(report.source, report.evidence, target), false);
    assert.throws(() => validateReport(report.snapshot, report.draft, new Set(['proof']), reads), /independent/);
    report.draft.findings[0].verdict = 'needs_evidence';
    assert.equal(validateReport(report.snapshot, report.draft, new Set(['proof']), reads).findings[0].verdict, 'needs_evidence');
  }
});

test('assembled and shared reports never copy private attestation metadata into the document', () => {
  const report = reportFixture();
  report.snapshot.config.criteria[0].delivery = { kind: 'test_cases', caseKeys: ['internal-item:internal-case'] };
  const document = assembleReport(report.snapshot, report.draft, new Set(['proof']));
  for (const output of [document, sharedReportDocument(document, ['proof'])]) {
    const serialized = JSON.stringify(output);
    for (const privateValue of ['provenance', 'evidencePolicyVersion', 'test-capture', 'run-a', digest, 'internal-item', 'internal-case']) assert.ok(!serialized.includes(privateValue));
  }
});

test('review and report conclusive applicability stays in parity across every mechanical boundary', () => {
  // Reviewer output/continuation contracts can evolve independently. Parity
  // below checks applicability behavior, not coincidental revision numbers.
  assert.equal(typeof REVIEWER_VERSION, 'string');
  assert.equal(MISSION_REPORT_VERSION, `${EVIDENCE_RULES_VERSION}:delivery-${DELIVERY_POLICY_VERSION}:reader-2:remediation-1:judgement-8:regression-1:task-history-2:reviewed-checks-2:model-glm-5.3:output-16000`);
  const scenarios = [
    ['current proof', () => {}, true],
    ['legacy source', f => { f.context.schemaVersion = 1; }, false],
    ['old policy', f => { f.evidence.evidencePolicyVersion = 1; }, false],
    ['missing provenance', f => { f.evidence.provenance = null; }, false],
    ['wrong run', f => { f.evidence.provenance.sourceId = 'other'; }, false],
    ['unknown target', f => { f.context.target = null; }, false],
    ['blank revision', f => { f.context.target = { ...target, revision: ' ' }; }, false],
    ['blank environment', f => { f.context.target = { ...target, environment: ' ' }; }, false],
    ['no observation time', f => { f.evidence.observedAt = null; f.evidence.provenance.observedAt = null; }, false],
    ['untrusted timestamp', f => { f.evidence.observedAt = '2026-10-05T10:00:31Z'; }, false],
    ['before run', f => { f.evidence.observedAt = f.evidence.provenance.observedAt = '2026-10-04T10:00:30Z'; }, false],
    ['invalid source start', f => { f.context.startedAt = 'invalid'; }, false],
    ['invalid source finish', f => { f.context.finishedAt = 'invalid'; }, false],
    ['no source finish', f => { f.context.finishedAt = null; }, false],
    ['reversed window', f => { f.context.startedAt = '2026-10-05T11:00:00Z'; }, false],
    ['unavailable', f => { f.read.unavailable = true; }, false],
    ['limited read', f => { f.read.limited = true; }, false],
    ['missing digest', f => { delete f.read.digest; }, false],
    ['wrong bytes', f => { f.read.digest = 'b'.repeat(64); }, false],
    ['unattested bytes', f => { delete f.evidence.provenance.sha256; }, false],
    ['capture receipt', f => { f.evidence.provenance.producer = 'capture-metadata'; }, false],
  ];
  for (const verdict of ['supported', 'contradicted']) for (const [label, mutate, expected] of scenarios) {
    const report = reportFixture(), review = reviewFixture();
    const reportRead = { id: 'proof', digest }, reviewRead = { id: 'proof', digest };
    mutate({ context: report.source, evidence: report.evidence, read: reportRead });
    mutate({ context: review.input, evidence: review.evidence, read: reviewRead });
    review.evidence.sha256 = reviewRead.digest;
    review.evidence.readStatus = reviewRead.unavailable ? 'unavailable' : reviewRead.limited ? 'limited' : 'read';
    report.draft.findings[0].verdict = review.assessment.verdict = review.assessment.findings[0].verdict = verdict;
    const actions = [
      () => validateReport(report.snapshot, report.draft, new Set(['proof']), new Map([['proof', reportRead]])),
      () => validateAssessment(review.input, review.assessment),
    ];
    for (const action of actions) if (expected) assert.doesNotThrow(action, `${label}: ${verdict}`); else assert.throws(action, undefined, `${label}: ${verdict}`);
  }
});

test('eligibility precedes reads but conclusive file support requires matching consumed bytes', () => {
  const report = reportFixture();
  assert.equal(independentMissionEvidence(report.source, report.evidence, target), true);
  assert.throws(() => validateReport(report.snapshot, report.draft, new Set(['proof'])), /independent/);
  const context = { ...report.source, expectedTarget: target };
  const candidate = { ...report.evidence, requiresDigest: true };
  assert.equal(evidenceApplicability(context, candidate, { requireRead: false }).eligible, true);
  assert.equal(evidenceApplicability(context, candidate).eligible, false);
  assert.equal(evidenceApplicability(context, { ...candidate, readStatus: 'read', digest }).eligible, true);
  assert.equal(evidenceApplicability(context, { ...candidate, readStatus: 'read', digest, stale: true }).eligible, false);
});

test('unused untrusted or unread attachments remain warnings without invalidating proved requirements', () => {
  const review = reviewFixture(), report = reportFixture();
  const optional = { ...review.evidence, id: 'optional', provenance: { version: 1, origin: 'tool', producer: 'capture-metadata', sourceType: 'test', sourceId: 'run-a', observedAt: time }, error: 'Earlier screenshot failed', readStatus: 'unavailable' };
  review.input.evidence.push(optional); review.input.ruleFindings = reviewRules(review.input);
  assert.ok(review.input.ruleFindings.some(rule => rule.code === 'evidence_unattested'));
  assert.ok(review.input.ruleFindings.some(rule => rule.code === 'evidence_unread'));
  assert.equal(validateAssessment(review.input, review.assessment).verdict, 'supported');
  report.source.evidence.push({ ...optional, unavailable: true });
  assert.equal(validateReport(report.snapshot, report.draft, new Set(['proof']), reads).findings[0].verdict, 'supported');
  review.assessment.findings[0].evidenceIds = ['optional'];
  report.draft.findings[0].evidenceIds = ['optional'];
  assert.throws(() => validateAssessment(review.input, review.assessment));
  assert.throws(() => validateReport(report.snapshot, report.draft, new Set(['optional']), new Map([['optional', { id: 'optional', unavailable: true }]])));
});

test('supported multi-source criteria require independent consumed proof for each requested source type', () => {
  const f = reportFixture();
  f.snapshot.config.criteria[0].delivery = { kind: 'source', sourceTypes: ['research', 'repository'] };
  f.source.sourceType = 'research'; f.source.target = null;
  f.evidence.kind = 'text'; f.evidence.provenance = { version: 1, origin: 'tool', producer: 'research-page', observedAt: time };
  const repoProof = { ...proof(), id: 'repo', kind: 'observation', provenance: { version: 1, origin: 'tool', producer: 'repository-runner', sourceType: 'repository', sourceId: 'repo-run', observedAt: time } };
  f.snapshot.tasks[0].sources.push({ ...f.source, sourceType: 'repository', sourceId: 'repo-run', target, evidence: [repoProof] });
  const read = new Set(['proof', 'repo']);
  assert.throws(() => validateReport(f.snapshot, f.draft, read), /every requested source type/);
  f.draft.findings[0].evidenceIds.push('repo');
  assert.equal(validateReport(f.snapshot, f.draft, read).findings[0].verdict, 'supported');
  repoProof.origin = 'agent'; repoProof.provenance = { version: 1, origin: 'agent', producer: 'agent-authored', observedAt: null };
  assert.throws(() => validateReport(f.snapshot, f.draft, read), /every requested source type/);
});

test('complete selected runs still require the report to read and cite each run', () => {
  const f = reportFixture();
  f.snapshot.config.criteria[0].delivery = { kind: 'test_cases', caseKeys: ['case-a', 'case-b'] };
  f.snapshot.delivery.cases = [{ caseKey: 'case-a', runId: 'run-a', complete: true, gaps: [] }, { caseKey: 'case-b', runId: 'run-b', complete: true, gaps: [] }];
  const second = { ...proof(), id: 'second', provenance: { ...proof().provenance, sourceId: 'run-b' } };
  f.snapshot.tasks[0].sources.push({ ...f.source, sourceId: 'run-b', evidence: [second] });
  const read = new Set(['proof', 'second']), allReads = new Map([...reads, ['second', { id: 'second', digest }]]);
  assert.throws(() => validateReport(f.snapshot, f.draft, read, allReads), /every selected run/);
  f.draft.findings[0].evidenceIds.push('second');
  assert.equal(validateReport(f.snapshot, f.draft, read, allReads).findings[0].verdict, 'supported');
  allReads.set('second', { id: 'second', digest: 'b'.repeat(64) });
  assert.throws(() => validateReport(f.snapshot, f.draft, read, allReads), /every selected run/);
});

test('repository and setup evidence must match a known mission revision, not its app URL or label', () => {
  for (const [sourceType, producer] of [['repository', 'repository-runner'], ['setup', 'environment-probe']]) {
    for (const revision of ['abc', 'older', '', null]) {
      const f = reportFixture();
      f.snapshot.config.criteria[0].delivery = { kind: 'source', sourceTypes: [sourceType] };
      f.source.sourceType = sourceType;
      f.source.target = revision === null ? null : { environment: 'VPS process', url: 'http://127.0.0.1:3000', revision };
      f.evidence.kind = 'observation';
      f.evidence.provenance = { version: 1, origin: 'tool', producer, sourceType, sourceId: f.source.sourceId, observedAt: time };
      const candidate = { ...f.evidence, readStatus: 'read' };
      const eligible = revision === 'abc';
      assert.equal(evidenceApplicability({ ...f.source, expectedTarget: target }, candidate).eligible, eligible, `${sourceType}:${revision}`);
      assert.equal(independentMissionEvidence(f.source, f.evidence, target), eligible);
      for (const verdict of ['supported', 'contradicted']) {
        f.draft.findings[0].verdict = verdict;
        if (eligible) assert.doesNotThrow(() => validateReport(f.snapshot, f.draft, new Set(['proof'])));
        else assert.throws(() => validateReport(f.snapshot, f.draft, new Set(['proof'])), /independent/);
      }
    }
  }
});

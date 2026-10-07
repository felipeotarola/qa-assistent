import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assessmentWithoutEvidence, validateAssessment } from '../shared/result-assessment.ts';
import { selectMissionReportEvidence } from '../shared/mission-report-evidence.ts';
import { validateReport } from '../shared/mission-report.ts';
import { reportEvidenceAvailability } from '../shared/mission-report-remediation.ts';
import { DELIVERY_POLICY_VERSION } from '../shared/mission-delivery.ts';

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { writeMissionReport } = await import('../agent/lib/mission-reporter.ts');
hooks.deregister();

function fixture() {
  const observedAt = '2026-10-06T10:00:30Z';
  const evidence = { id: 'item:unknown-version', itemId: 'unknown-version', version: 1, hash: 'saved-metadata-hash', title: 'Saved observation', kind: 'text', excerpt: 'UNREAD_SECRET_SENTINEL', url: 'https://fixture.test/',
    origin: 'tool', evidencePolicyVersion: 2, unavailable: false, observedAt,
    provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: 'run', observedAt, sha256: 'a'.repeat(64) } };
  const review = { schemaVersion: 2, runId: 'run', workspaceId: 'workspace', planVersion: 1, environment: 'unknown', target: null,
    startedAt: '2026-10-06T10:00:00Z', finishedAt: '2026-10-06T10:01:00Z', requirements: [{ id: 'expected', requirement: 'Verify version B' }],
    reportedResult: { schemaVersion: 2, outcome: 'inconclusive', actual: 'Version unknown', observations: [], evidenceItemIds: ['unknown-version'], checks: [{ id: 'expected', status: 'unverified', actual: 'Version unknown' }], remaining: [{ checkId: 'expected', reason: 'Unknown version' }] },
    evidence: [{ ...evidence, id: 'unknown-version', runId: 'run', readStatus: 'read', sha256: evidence.provenance.sha256 }], ruleFindings: [] };
  const snapshot = { schemaVersion: 2, config: { target: null, goal: 'Assess whether the saved observation verifies B', criteria: [{ id: 'qa', text: 'Assess selected evidence', delivery: { kind: 'source', sourceTypes: ['test'], sourceRefs: [{ type: 'test', id: 'run' }] } }] },
    delivery: { schemaVersion: DELIVERY_POLICY_VERSION, complete: false, criteria: [{ criterionId: 'qa', complete: false, gaps: [] }], cases: [], gaps: [] },
    tasks: [{ id: 'report-input', criterionIds: ['qa'], sources: [{ schemaVersion: 2, sourceType: 'test', sourceId: 'run', target: null, startedAt: review.startedAt, finishedAt: review.finishedAt,
      status: 'completed', summary: 'Version unknown', claims: [{ id: 'expected', requirement: 'Verify version B', reportedStatus: 'unverified', reportedActual: 'Version unknown' }], evidence: [evidence] }] }] };
  return { review, snapshot };
}

test('deterministic policy-excluded review never claims stored readable bytes are absent or supports the result', () => {
  const { review } = fixture(), before = structuredClone(review);
  const result = assessmentWithoutEvidence(review);
  assert.equal(result.verdict, 'needs_evidence');
  assert.match(result.summary, /tillämpligt, oberoende/);
  assert.ok(result.findings.every(finding => finding.gap.kind === 'environment_prerequisite' && finding.evidenceIds.length === 0));
  assert.ok(!result.findings.some(finding => /saknar läsbart/.test(finding.explanation)));
  assert.throws(() => validateAssessment(review, { ...result, verdict: 'supported', findings: result.findings.map(finding => ({ ...finding, gap: null, verdict: 'supported', evidenceIds: ['unknown-version'] })) }));
  assert.deepEqual(review, before);
  review.evidence[0].readStatus = 'unavailable';
  assert.equal(assessmentWithoutEvidence(review).verdict, 'needs_evidence');
  review.evidence = [];
  assert.equal(assessmentWithoutEvidence(review).verdict, 'needs_evidence');
});

test('code owns policy-exclusion facts while the actual SDK writer receives no unread-source diagnosis', async () => {
  const { snapshot } = fixture(), original = structuredClone(snapshot);
  assert.deepEqual(selectMissionReportEvidence(snapshot).evidenceIds, []);
  const draft = { summary: 'The stored observation cannot verify version B because its target is unknown.', findings: [{ criterionId: 'qa', verdict: 'needs_evidence', conclusion: 'Stored material exists, but cannot establish version B.', evidenceIds: [], nextStep: 'Establish the original target.' }], limitations: ['The registered source was not read because its target is unknown.'] };
  const wire = { checkAssessments: [], findings: [{ criterionId: 'qa', verdict: 'needs_evidence', factualNotes: [] }] };
  const oldFetch = globalThis.fetch, oldKey = process.env.GRUNDEN_API_TOKEN;
  process.env.GRUNDEN_API_TOKEN = 'synthetic-fixture-key';
  let calls = 0, captured;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.grunden.ai/v1/chat/completions'); calls++; captured = JSON.parse(options.body);
    return Response.json({ id: 'synthetic', model: 'fixture', object: 'chat.completion', created: 0,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(wire) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  };
  try {
    const result = await writeMissionReport(snapshot, async () => { throw new Error('Policy excluded source must not be read or cited'); }, AbortSignal.timeout(5000));
    assert.equal(calls, 1); assert.equal(result.usage.toolCalls, 0); assert.equal(result.usage.provider.providerCalls, 1);
    const context = JSON.parse(captured.messages.at(-1).content.find(part => part.type === 'text').text);
    const availability = reportEvidenceAvailability(snapshot, new Map());
    assert.equal(availability.registered, 1); assert.equal(availability.unread, 1); assert.equal(availability.unavailable, 0); assert.equal(availability.policyExcluded, 1);
    assert.deepEqual(context.sources, []); assert.deepEqual(context.evidenceSelection.readEvidenceIds, []);
    assert.equal(context.evidenceAvailability, undefined); assert.equal(context.evidenceSelection.omittedCandidateCount, undefined);
    assert.deepEqual(context.findingConstraints[0].allowedVerdicts, ['needs_evidence']);
    assert.ok(!JSON.stringify(captured).includes('UNREAD_SECRET_SENTINEL'));
    assert.match(captured.messages.find(message => message.role === 'system').content, /Beskriv inte orsaker till att andra källor saknas/);
    assert.equal(validateReport(snapshot, result.draft, new Set(), new Map()).findings[0].verdict, 'needs_evidence');
    assert.deepEqual(result.draft.findings[0].observations, []); assert.deepEqual(result.draft.findings[0].evidenceIds, []);
    assert.throws(() => validateReport(snapshot, { ...draft, findings: [{ ...draft.findings[0], verdict: 'supported', evidenceIds: ['item:unknown-version'] }] }, new Set(), new Map()));
    assert.deepEqual(snapshot, original);
  } finally { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.GRUNDEN_API_TOKEN; else process.env.GRUNDEN_API_TOKEN = oldKey; }
});

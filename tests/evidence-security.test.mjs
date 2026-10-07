import assert from 'node:assert/strict';
import test from 'node:test';
import { SECURITY_PROTOCOL, validateEvidenceSecurityManifest, validateSecurityOriginal, probeSecurityReports, securityContractGate, securityNaturalPrompt, securityReportPath } from './helpers/evidence-security.mjs';
import { fingerprint } from './helpers/evidence-acceptance.mjs';
import { SECURITY_PREPARATION_PROTOCOL, securityManifestFromPreparation } from './helpers/evidence-security-prepare.mjs';
const ref = (name, runtime) => { const marker = `evidence-owner-marker-${(name === 'a' ? 'a' : name === 'b' ? 'b' : 'c').repeat(16)}`; return { workspaceId: `workspace-${name}`, reportId: `report-${name}`, runtime, marker, documentHash: fingerprint({ summary: marker }) }; };
function fixture() {
  const trial = { requesterAccountFile: 'requester.json', ownerAccountFile: 'owner.json', requesterId: 'requester', ownerId: 'owner',
    allowed: ref('a', 'autonomy-test:current'), private: ref('b', 'autonomy-test:current'), foreignRuntime: ref('c', 'autonomy-test:foreign'), originArtifacts: [{ path: 'originals.json', sha256: 'a'.repeat(64) }] };
  return { protocol: SECURITY_PROTOCOL, taskId: 'SEC-08', variant: 'owner-runtime-anonymous-contract', sourceHash: 'a'.repeat(64), runtime: 'autonomy-test:current', preparation: 'synthetic-golden', trials: [trial] };
}
test('SEC manifest freezes independent positive/foreign owner/foreign runtime sources', () => {
  validateEvidenceSecurityManifest(fixture());
  for (const mutate of [m => m.trials[0].ownerId = 'requester', m => m.trials[0].foreignRuntime.runtime = m.runtime,
    m => m.trials[0].private.documentHash = 'unlocked', m => m.trials[0].private = m.trials[0].allowed, m => m.inject = 'result']) {
    const m = fixture(); mutate(m); assert.throws(() => validateEvidenceSecurityManifest(m));
  }
  const prompt = securityNaturalPrompt('http://127.0.0.1:58000', fixture().trials[0]); assert.match(prompt, /utan att köra tester/); assert.ok(!prompt.includes('evidence-owner-marker'));
});
test('SEC fixture must exist with correct owner, runtime, marker and immutable saved document', () => {
  const r = fixture().trials[0].foreignRuntime, row = { report_id: r.reportId, workspace_id: r.workspaceId, user_id: 'requester', runtime: r.runtime,
    status: 'completed', item_id: 'item', lifecycle: 'closed', document: { summary: r.marker } };
  validateSecurityOriginal(row, r, 'requester');
  for (const value of [null, { ...row, user_id: 'owner' }, { ...row, runtime: 'autonomy-test:current' }, { ...row, document: { summary: 'different' } }]) assert.throws(() => validateSecurityOriginal(value, r, 'requester'));
});
test('actual transport adapter probes three denied identities plus both ordinary owner controls', async () => {
  const trial = fixture().trials[0], calls = [];
  const read = async (path, cookie) => {
    calls.push({ path, cookie });
    const r = [trial.allowed, trial.private].find(r => securityReportPath(r) === path);
    if (r && cookie === (r === trial.allowed ? 'requester-cookie' : 'owner-cookie')) return { status: 200, body: JSON.stringify({ document: { summary: r.marker } }) };
    return { status: 404, body: '{"error":"Not found"}' };
  };
  const probes = await probeSecurityReports({ trial, requesterCookie: 'requester-cookie', ownerCookie: 'owner-cookie', read });
  assert.equal(probes.length, 5); assert.equal(calls[4].cookie, 'requester-cookie'); assert.equal(calls[3].cookie, null);
  const gate = securityContractGate([1, 2, 3].map(() => ({ result: 'passed', probes })));
  assert.equal(gate.contractVerified, true); assert.equal(gate.gate, false); assert.equal(gate.modelContextNonLeakage, 'not_verified');
});
test('a 200 denial, leaked marker or missing positive control cannot pass SEC', async () => {
  const trial = fixture().trials[0];
  for (const fault of ['missing-owner', 'allowed-foreign', 'leak']) {
    const read = async (path, cookie) => {
      const ref = [trial.allowed, trial.private, trial.foreignRuntime].find(r => securityReportPath(r) === path);
      const allowed = cookie === (ref === trial.private ? 'owner-cookie' : 'requester-cookie') && ref !== trial.foreignRuntime;
      if (allowed) return { status: fault === 'missing-owner' ? 404 : 200, body: JSON.stringify({ document: { summary: ref.marker } }) };
      return { status: fault === 'allowed-foreign' ? 200 : 403, body: fault === 'leak' ? ref.marker : 'denied' };
    };
    await assert.rejects(probeSecurityReports({ trial, requesterCookie: 'requester-cookie', ownerCookie: 'owner-cookie', read }));
  }
});
test('synthetic preparation locks exact report bytes and never implies model execution', () => {
  const t = fixture().trials[0], artifact = { protocol: SECURITY_PREPARATION_PROTOCOL, preparation: 'synthetic-golden', realProviderCalls: 0, realBrowserActions: 0,
    completedAt: '2026-10-05T10:00:00Z', runtime: 'autonomy-test:current', requesterId: 'requester', ownerId: 'owner', trials: [{ state: 'prepared', allowed: t.allowed, private: t.private, foreignRuntime: t.foreignRuntime }] };
  const compile = value => securityManifestFromPreparation({ artifact: value, artifactPath: '.data/autonomy-isolation/prep.json', artifactBytes: Buffer.from(JSON.stringify(value)),
    requesterAccountFile: '.data/autonomy-isolation/a.json', ownerAccountFile: '.data/autonomy-isolation/b.json', sourceHash: 'a'.repeat(64) });
  assert.equal(compile(artifact).preparation, 'synthetic-golden');
  for (const mutate of [a => a.realProviderCalls = 1, a => a.trials[0].state = 'preparing', a => a.preparationFailed = true, a => a.trials[0].foreignRuntime.runtime = a.runtime]) {
    const value = structuredClone(artifact); mutate(value); assert.throws(() => compile(value));
  }
});

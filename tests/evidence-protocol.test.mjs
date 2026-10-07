import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EVIDENCE_PROTOCOL, EVIDENCE_PROTOCOLS, evidencePrompt, sha256 } from './helpers/evidence-acceptance.mjs';
import { REPORT_FAULT_PROTOCOL, REPORT_FAULT_PROTOCOLS, REPORT_FAULT_PREPARATION } from './helpers/report-fault-contract.mjs';
import { reportFaultManifest } from './helpers/report-fault-compile.mjs';

const hash = 'a'.repeat(64);
const ordinary = protocol => ({ protocol, catalogVersion: '2026-10-05', taskId: 'REP-06', variant: 'normal', sourceHash: hash, runtime: 'autonomy-test:protocol', model: 'glm-5.3-flash', reasoning: 'low', observationSeconds: 1500,
  trials: [{ workspaceId: 'protocol-workspace', accountFile: '.data/autonomy-isolation/no-account.json', selection: [{ type: 'test', id: 'private-run', label: 'Versionskontrollen' }], seedHash: hash, targetRevision: 'B', originArtifacts: [] }] });
const historical = () => ({ ...ordinary('syna-evidence-acceptance-v4'), taskId: 'REP-05', variant: 'historical-review-gap', preparation: 'preserved-actual' });
function compiledFault() {
  return reportFaultManifest({ preparation: { protocol: REPORT_FAULT_PREPARATION, taskId: 'REP-06', reviewerVersion: '8', runtime: 'autonomy-test:protocol', completedAt: '2026-10-06T00:00:00Z', realProviderCalls: 0, realBrowserActions: 0,
    trials: [1, 2, 3].map(i => ({ workspaceId: `protocol-workspace-${i}`, seedHash: hash, selection: [{ type: 'test', id: `private-run-${i}`, label: 'Versionskontrollen' }],
      mutation: { itemId: `private-item-${i}`, version: 1, contentHash: hash, replacementText: 'SYNTHETIC FAULT SOURCE EDIT: changed' } })) },
  preparationPath: '.data/autonomy-isolation/no-preparation.json', preparationSha256: hash, accountFile: '.data/autonomy-isolation/no-account.json', sourceHash: hash,
  configFile: '.data/autonomy-isolation/no-config.json', receiptFile: '.data/autonomy-isolation/no-receipt.jsonl', codeHashes: { a: hash, b: hash, c: hash, d: hash } });
}
test('new ordinary v3 and fault v2 manifests preserve exact historical protocols during pure CLI validation', async () => {
  assert.equal(EVIDENCE_PROTOCOL, 'syna-evidence-acceptance-v3');
  assert.equal(REPORT_FAULT_PROTOCOL, 'syna-report-fault-acceptance-v2');
  const fault = compiledFault(); assert.equal(fault.protocol, REPORT_FAULT_PROTOCOL);
  const directory = await mkdtemp(join(tmpdir(), 'syna-evidence-protocol-'));
  try {
    for (const [index, manifest] of [...EVIDENCE_PROTOCOLS.map(protocol => protocol === 'syna-evidence-acceptance-v4' ? historical() : ordinary(protocol)), ...REPORT_FAULT_PROTOCOLS.map(protocol => ({ ...fault, protocol }))].entries()) {
      const file = join(directory, `manifest-${index}.json`), bytes = JSON.stringify(manifest);
      await writeFile(file, bytes, { flag: 'wx' });
      const { stdout } = await promisify(execFile)(process.execPath, ['tests/autonomy-evidence.acceptance.mjs', '--validate', `--manifest=${file}`], { windowsHide: true, maxBuffer: 1024 * 1024 });
      const output = JSON.parse(stdout);
      assert.equal(output.protocol, manifest.protocol, 'Historical metadata must not silently upgrade to latest');
      assert.equal(output.manifestSha256, sha256(bytes)); assert.equal(output.modelCalls, 0); assert.equal(output.networkRequests, 0);
      assert.equal(output.result, 'manifest_validated'); assert.equal(output.gate, false);
      assert.equal(output.attempts[0].prompt, evidencePrompt(manifest, manifest.trials[0]));
      assert.equal(output.attempts[0].promptSha256, sha256(output.attempts[0].prompt));
      if (!manifest.protocol.endsWith('-v1')) assert.match(output.attempts[0].prompt, /spara en rapport/);
      else assert.doesNotMatch(output.attempts[0].prompt, /spara en rapport/);
      assert.equal(await readFile(file, 'utf8'), bytes);
    }
    // v4 is a distinct preserved-history contract, never a new default for an
    // ordinary REP06/normal manifest. Validate the real CLI rejection too.
    const invalid = join(directory, 'ordinary-v4-rejected.json'), bytes = JSON.stringify(ordinary('syna-evidence-acceptance-v4'));
    await writeFile(invalid, bytes, { flag: 'wx' });
    await assert.rejects(promisify(execFile)(process.execPath, ['tests/autonomy-evidence.acceptance.mjs', '--validate', `--manifest=${invalid}`], { windowsHide: true, maxBuffer: 1024 * 1024 }),
      error => error.code === 1 && /v4 is restricted to preserved actual REP-05 historical review gaps/.test(error.stderr));
    assert.equal(await readFile(invalid, 'utf8'), bytes);
  } finally {
    const owned = relative(tmpdir(), directory); assert.ok(owned && !isAbsolute(owned) && !owned.startsWith(`..${sep}`));
    await rm(directory, { recursive: true });
  }
});

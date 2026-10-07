import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const EVIDENCE_GAP_LAUNCHER = "import {createServer} from 'node:http';\nimport {evidenceSearchHandler} from './server.mjs';\ncreateServer(evidenceSearchHandler).listen(80,'0.0.0.0');\n";
export const gapConfigHash = value => createHash('sha256').update(value).digest('hex');

/** Pure configuration check; actual deployment/HTTP verification is performed
 * separately by the owner. This does not claim that any QA action succeeded. */
export function assertEvidenceGapDeployment(manifest, hashes) {
  assert.equal(manifest?.schemaVersion, 1); assert.equal(manifest.kind, 'evidence-gap');
  assert.equal(manifest.origin, 'http://qa-evidence.test');
  assert.equal(manifest.address, '192.0.2.13'); assert.equal(manifest.port, 80);
  assert.match(hashes.runtimeScope ?? '', /^autonomy-test:[a-z0-9-]+$/);
  for (const name of ['serverSha256', 'launcherSha256', 'resolverSha256']) {
    assert.match(hashes[name] ?? '', /^[a-f0-9]{64}$/);
    assert.equal(manifest[name], hashes[name], `Evidence fixture ${name} differs`);
  }
  assert.equal(manifest.runtimeScope, hashes.runtimeScope);
  assert.equal(manifest.launcherSha256, gapConfigHash(EVIDENCE_GAP_LAUNCHER));
  assert.equal(manifest.container, `qa-evidence-gap-${hashes.serverSha256.slice(0, 12)}`);
  assert.equal(manifest.directory, `/opt/syna-autonomy/fixtures/evidence-gap-${hashes.serverSha256.slice(0, 12)}`);
  assert.equal(manifest.oracleNotServed, true); assert.equal(manifest.transport, 'isolated-docker-public-origin');
  for (const name of ['browserImage', 'containerImage']) assert.match(manifest[name] ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.match(manifest.containerId ?? '', /^[a-f0-9]{64}$/);
  return manifest;
}

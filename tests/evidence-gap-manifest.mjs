// Offline manifest compiler only; it does not provision, authenticate or execute.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { relative, isAbsolute, resolve, sep } from 'node:path';
import { readIsolationFixture } from './helpers/autonomy-isolation.mjs';
import { sha256 } from './helpers/evidence-acceptance.mjs';
import { gapManifests, gapReportOnlyManifest } from './helpers/evidence-gap-prepare.mjs';
const root = resolve('.data/autonomy-isolation');
assert.ok(process.argv.includes('--compile'), 'Explicit --compile --input=<private JSON> required');
async function bytes(path) {
  const candidate = resolve(path), canonical = await realpath(candidate), sub = relative(root, canonical);
  assert.ok(sub && sub !== '..' && !sub.startsWith(`..${sep}`) && !isAbsolute(sub) && candidate === canonical);
  assert.ok((await stat(canonical)).size <= 128 * 1024 * 1024); return readFile(canonical);
}
const input = JSON.parse(await bytes(process.argv.find(a => a.startsWith('--input='))?.slice(8))), f = await readIsolationFixture();
assert.ok(['resolvable', 'persistent', 'report-only'].includes(input.variant));
const batch = randomUUID(), path = resolve(root, `evidence-gap-manifest-${input.variant}-${batch}.json`);
if (input.variant === 'report-only') {
  assert.ok(Object.keys(input).every(k => ['variant', 'originArtifact', 'accountFiles', 'observationSeconds'].includes(k)));
  const originBytes = await bytes(input.originArtifact);
  const manifest = gapReportOnlyManifest({ originBytes, originPath: input.originArtifact, sourceHash: f.app.sourceSha256, runtime: f.runtimeScope,
    accountFiles: input.accountFiles, observationSeconds: input.observationSeconds });
  await writeFile(path, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ result: 'compiled', acceptanceManifest: path, networkRequests: 0, databaseWrites: 0, modelCalls: 0 }));
} else {
  assert.ok(Object.keys(input).every(k => ['variant', 'origin', 'trials', 'observationSeconds'].includes(k)));
  const fixturePath = 'tests/fixtures/evidence-gap-site.mjs';
  const value = gapManifests({ sourceHash: f.app.sourceSha256, runtime: f.runtimeScope, variant: input.variant,
    fixture: { path: fixturePath, sha256: sha256(await readFile(fixturePath)), origin: input.origin, resultPath: '/search', queryKey: 'q' },
    trials: input.trials, observationSeconds: input.observationSeconds,
    driverSha256: sha256(await readFile('tests/autonomy-evidence-gap-fault.mjs')), helperSha256: sha256(await readFile('tests/helpers/evidence-gap-fault.mjs')),
    receiptFile: resolve(root, `evidence-gap-fault-${batch}.json`), acceptancePath: path });
  const driverPath = resolve(root, `evidence-gap-driver-${batch}.json`);
  await writeFile(path, value.acceptanceBytes, { flag: 'wx' }); await writeFile(driverPath, JSON.stringify(value.driver, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ result: 'compiled', acceptanceManifest: path, driverManifest: driverPath, networkRequests: 0, databaseWrites: 0, modelCalls: 0,
    pending: 'Fresh owned workspaces, separately provisioned fixture at this exact origin, independent physical-driver review, and an exclusive fault window must be verified before arming.' }));
}

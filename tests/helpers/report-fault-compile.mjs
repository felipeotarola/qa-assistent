import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readIsolationFixture } from './autonomy-isolation.mjs';
import { reportFaultPrivateFile } from './report-fault-control.mjs';
import { REPORT_FAULT_PROTOCOL, REPORT_FAULT_PREPARATION, reportFaultVariants, validateReportFaultManifest } from './report-fault-contract.mjs';
import { sha256 } from './evidence-acceptance.mjs';

export function reportFaultManifest({ preparation, preparationPath, preparationSha256, accountFile, sourceHash, configFile, receiptFile, codeHashes }) {
  assert.equal(preparation.protocol, REPORT_FAULT_PREPARATION); assert.ok(preparation.completedAt && !preparation.preparationFailed);
  assert.equal(preparation.realProviderCalls, 0); assert.equal(preparation.realBrowserActions, 0); assert.equal(preparation.trials.length, 3);
  return validateReportFaultManifest({ protocol: REPORT_FAULT_PROTOCOL, catalogVersion: '2026-10-05', taskId: preparation.taskId,
    variant: reportFaultVariants[preparation.taskId], sourceHash, runtime: preparation.runtime, model: 'glm-5.3-flash', reasoning: 'low', observationSeconds: 1500,
    preparation: 'synthetic-golden', reviewerVersion: preparation.reviewerVersion,
    fault: { configFile, receiptFile, codeHashes, maxHoldMs: 10000 },
    trials: preparation.trials.map(trial => ({ workspaceId: trial.workspaceId, accountFile, selection: trial.selection, seedHash: trial.seedHash,
      ...(preparation.taskId === 'REP-06' ? { targetRevision: 'B', mutation: trial.mutation } : {}), ...(preparation.taskId === 'REP-07' ? { wrongRun: trial.wrongRun } : {}),
      originArtifacts: [{ path: preparationPath, sha256: preparationSha256 }] })),
  }, { execute: true });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.argv.includes('--compile'), 'Explicit --compile is required');
  const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const fixtureFile = argument('fixture'), preparationPath = argument('preparation'), accountFile = argument('account'), manifestFile = argument('manifest'), configFile = argument('config'), receiptFile = argument('receipt');
  assert.ok([fixtureFile, preparationPath, accountFile, manifestFile, configFile, receiptFile].every(Boolean));
  const fixture = await readIsolationFixture(fixtureFile), bytes = await reportFaultPrivateFile(preparationPath), preparation = JSON.parse(bytes);
  assert.equal(preparation.runtime, fixture.runtimeScope);
  const codeHashes = {};
  for (const path of [...(await readdir('tests/helpers')).filter(name => /^report-fault-.*\.mjs$/.test(name)).map(name => `tests/helpers/${name}`), 'tests/autonomy-evidence.acceptance.mjs', 'tests/helpers/autonomy-web-restart.mjs']) codeHashes[path] = sha256(await readFile(path));
  for (const path of [manifestFile, configFile, receiptFile]) assert.equal(resolve(path, '..'), resolve('.data/autonomy-isolation'), 'Outputs must be fresh files directly in the owned isolation directory');
  const manifest = reportFaultManifest({ preparation, preparationPath, preparationSha256: sha256(bytes), accountFile, sourceHash: fixture.app.sourceSha256, configFile, receiptFile, codeHashes });
  const text = JSON.stringify(manifest, null, 2), controlPort = Number(argument('control-port'));
  assert.ok(Number.isInteger(controlPort) && controlPort > 1024 && controlPort < 65536);
  const config = { kind: 'syna-report-fault-driver', version: 1, fixtureFile, manifestFile, manifestSha256: sha256(text),
    upstreamDatabaseUrl: fixture.databaseUrl, appOrigin: 'http://127.0.0.1:58000', controlPort, controlKey: randomBytes(32).toString('hex'),
    deadlineAt: new Date(Date.now() + 4800_000).toISOString(), ...(manifest.taskId === 'REP-05' ? { pgPort: Number(argument('pg-port')) } : {}) };
  if (manifest.taskId === 'REP-05') assert.ok(Number.isInteger(config.pgPort) && config.pgPort > 1024 && config.pgPort < 65536 && config.pgPort !== controlPort);
  await writeFile(manifestFile, text, { flag: 'wx' }); await writeFile(configFile, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ state: 'compiled_not_activated', manifestFile, configFile, taskId: manifest.taskId, variant: manifest.variant, deadlineAt: config.deadlineAt, requiresStartupIntegration: true }));
}

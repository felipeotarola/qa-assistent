import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { environmentPlanHash, environmentRequestFingerprint } from '../shared/mission-environment.mjs';
import { plan, execution } from './approved-plan-fixture.mjs';

const runtime = 'unit:environment';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tables = ['environmentConsents', 'setupJobs', 'repositoryRuns', 'missionTasks'];
const schema = Object.fromEntries(tables.map(name => [name, new Proxy({ name }, { get: (object, key) => key === 'name' ? object.name : key })]));
globalThis.__approvedPlanPorts = {
  schema, currentMandate: mission => mission.mandate, runtimeScope: () => runtime, missionHash: hash,
  authorizeEnvironmentConsent: async (_user, _workspace, request, { connection, deadline }) => {
    connection.authorizations.push(request);
    if (connection.authorityFailure) throw Object.assign(Error('Denied'), { statusCode: 409 });
    return { validUntil: deadline.toISOString() };
  },
};
globalThis.createError = options => Object.assign(Error(options.statusMessage), options);
const stub = name => `reuse-test:${name}`;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/server/utils/mission-environment-reuse.ts')) {
      if (specifier === 'drizzle-orm') return { url: stub('drizzle'), shortCircuit: true };
      if (specifier === '@nuxthub/db') return { url: stub('schema'), shortCircuit: true };
      if (['./mission-control', './environment-consents', './mission-sources', '../../shared/runtime-scope'].includes(specifier)) return { url: stub('ports'), shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const sources = {
      [stub('drizzle')]: 'export const eq=(column,value)=>row=>row[column]===value; export const and=(...checks)=>row=>checks.every(check=>check(row));',
      [stub('schema')]: 'export const {schema}=globalThis.__approvedPlanPorts;',
      [stub('ports')]: 'export const {currentMandate,authorizeEnvironmentConsent,missionHash,runtimeScope}=globalThis.__approvedPlanPorts;',
    };
    return Object.hasOwn(sources, url) ? { source: sources[url], format: 'module', shortCircuit: true } : next(url, context);
  },
});
const { approvedMissionPreparation, findApprovedMissionPreparation } = await import(pathToFileURL(resolve('server/utils/mission-environment-reuse.ts')));

function fixture() {
  const mission = { id: randomUUID(), userId: randomUUID(), workspaceId: randomUUID(), planRevision: 1,
    deadlineAt: new Date(Date.now() + 60000), mandate: { consentIds: [], repositoryUrls: [plan().repoUrl] } };
  const old = execution(), sourceId = old.dispatchId, inspectionId = randomUUID(), discoveryId = randomUUID();
  const environmentExecution = { version: 1, phase: 'prepare', repoUrl: plan().repoUrl, commit: plan().commit, inspectedRunId: randomUUID() };
  const source = { id: sourceId, workspaceId: mission.workspaceId, runtime, status: 'needs_configuration', task: 'Original prepare',
    autonomy: { execution: old, environmentExecution, fingerprint: environmentRequestFingerprint(old, 'Original prepare', environmentExecution) } };
  source.result = { execution: old, environmentExecution, fingerprint: source.autonomy.fingerprint, environment: { ...plan(), probeKind: 'identity', httpStatus: null }, cleanup: 'confirmed', executorStopped: true };
  const consent = { id: randomUUID(), userId: mission.userId, workspaceId: mission.workspaceId, runtime, revision: 1, vaultRevision: 2,
    grantSetupJobId: sourceId, repoUrl: plan().repoUrl, plan: plan(), planHash: environmentPlanHash(plan()) };
  mission.mandate.consentIds.push(consent.id);
  const spec = { kind: 'environment_setup', phase: 'prepare', repoUrl: plan().repoUrl, expectedCommit: plan().commit, inspectedRunId: inspectionId,
    approvedPreparation: { consentId: consent.id, consentRevision: 1, vaultRevision: 2, sourceSetupJobId: sourceId, planHash: consent.planHash } };
  const inspection = { id: inspectionId, workspaceId: mission.workspaceId, runtime,
    config: { mode: 'inspect', url: plan().repoUrl, execution: { missionId: mission.id, taskId: discoveryId } },
    job: { status: 'review', commit: plan().commit, cleanup: { confirmed: true }, plan: { runtime: 'node24', directory: '.' } } };
  const discovery = { id: discoveryId, missionId: mission.id, planRevision: 1, spec: { kind: 'discovery' }, sources: [{ type: 'repository', id: inspectionId }] };
  const rows = { environmentConsents: [consent], setupJobs: [source], repositoryRuns: [inspection], missionTasks: [discovery] };
  const tx = { authorizations: [], select: () => ({ from: table => ({ where: predicate => Promise.resolve(rows[table.name].filter(predicate)) }) }) };
  return { mission, spec, consent, source, inspection, discovery, rows, tx };
}

test('exact explicit grant selects a new prepare reference; historical mission and records remain immutable', async () => {
  const f = fixture(), original = structuredClone(f.rows);
  const found = await findApprovedMissionPreparation(f.tx, f.mission, { ...f.spec, approvedPreparation: undefined });
  assert.deepEqual(found, f.spec.approvedPreparation);
  const approved = await approvedMissionPreparation(f.tx, f.mission, f.spec, f.mission.deadlineAt);
  assert.deepEqual(approved.plan, plan());
  assert.deepEqual(f.rows, original);
  assert.equal(f.tx.authorizations.length, 2);
  assert.equal(f.tx.authorizations[1].setupJobId, f.source.id);
  assert.notEqual(f.source.autonomy.execution.missionId, f.mission.id);
});

test('owner, workspace, runtime, original lineage and fresh inspected project are exact', async () => {
  const changes = [
    f => { f.consent.userId = randomUUID(); },
    f => { f.consent.workspaceId = randomUUID(); },
    f => { f.consent.runtime = 'other'; },
    f => { f.source.runtime = 'other'; },
    f => { f.source.result.cleanup = 'unknown'; },
    f => { f.source.result.executorStopped = false; },
    f => { f.source.result.fingerprint = 'a'.repeat(64); },
    f => { f.source.result.execution = execution(); },
    f => { f.source.result.environmentExecution = { ...f.source.result.environmentExecution, commit: 'b'.repeat(40) }; },
    f => { f.source.result.environment.httpStatus = 200; },
    f => { f.source.result.environment.processId = randomUUID(); },
    f => { f.source.task = 'Changed original request'; },
    f => { f.inspection.config.execution.missionId = randomUUID(); },
    f => { f.inspection.job.commit = 'b'.repeat(40); },
    f => { f.inspection.job.plan.directory = 'apps/other'; },
    f => { f.inspection.job.plan.runtime = 'other'; },
    f => { f.discovery.planRevision++; },
    f => { f.discovery.sources = []; },
    f => { f.mission.mandate.consentIds = []; },
    f => { f.mission.mandate.repositoryUrls = []; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    await assert.rejects(approvedMissionPreparation(f.tx, f.mission, f.spec, f.mission.deadlineAt), { statusCode: 409 });
    assert.equal(f.tx.authorizations.length, 0);
  }
});

test('live consent check denies frozen selection without fallback, while initial selection may decline', async () => {
  const f = fixture(); f.tx.authorityFailure = true;
  await assert.rejects(approvedMissionPreparation(f.tx, f.mission, f.spec, f.mission.deadlineAt), { statusCode: 409 });
  assert.equal(await findApprovedMissionPreparation(f.tx, f.mission, f.spec), undefined);
  f.tx.authorityFailure = false;
  f.consent.vaultRevision++;
  await assert.rejects(approvedMissionPreparation(f.tx, f.mission, f.spec, f.mission.deadlineAt), { statusCode: 409 });
});

test('two different approved plans are not silently resolved by record order', async () => {
  const f = fixture(), second = fixture();
  second.consent.userId = f.mission.userId; second.consent.workspaceId = f.mission.workspaceId;
  second.consent.plan.command = 'npm start'; second.consent.planHash = environmentPlanHash(second.consent.plan);
  second.source.workspaceId = f.mission.workspaceId;
  second.source.result.environment.command = second.consent.plan.command;
  f.rows.environmentConsents.push(second.consent); f.rows.setupJobs.push(second.source);
  f.mission.mandate.consentIds.push(second.consent.id);
  assert.equal(await findApprovedMissionPreparation(f.tx, f.mission, f.spec), undefined);
  assert.equal(f.tx.authorizations.length, 2);
});

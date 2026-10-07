// Real database transactions, isolated fixtures, fake provider boundary.
// No Linear account, network write or user workspace is touched.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import { createError } from 'h3';

if (process.env.RUN_WORKSPACE_TESTS !== '1') throw new Error('Set RUN_WORKSPACE_TESTS=1');
const encodeModule = code => `data:text/javascript,${encodeURIComponent(code)}`;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@nuxthub/db') return { url: encodeModule('export const db = globalThis.requirementsTestDb; export const schema = globalThis.requirementsTestSchema;'), shortCircuit: true };
  if (specifier === './external' && context.parentURL?.endsWith('/server/utils/test-requirements.ts')) return { url: encodeModule('export const destinations = (...args) => globalThis.requirementsTestProvider.destinations(...args); export const externalOperation = (...args) => globalThis.requirementsTestProvider.operation(...args);'), shortCircuit: true };
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const schema = { ...await import('../server/db/schema/workspaces.ts'), ...await import('../server/db/schema/auth.ts'), ...await import('../server/db/schema/external.ts'), ...await import('../server/db/schema/test-requirements.ts'), ...await import('../server/db/schema/missions.ts') };
// Match the application's small pool: publication must not request a third
// connection while its lock and local apply transaction occupy both slots.
const connection = postgres(process.env.POSTGRES_URL || process.env.POSTGRESQL_URL || process.env.DATABASE_URL, { prepare: false, max: 2 });
const db = drizzle(connection);
globalThis.requirementsTestDb = db;
globalThis.requirementsTestSchema = schema;
globalThis.createError = createError;
const userId = randomUUID(), workspaceId = randomUUID(), itemId = randomUUID(), caseId = randomUUID();
const destination = {provider:'linear',targetId:randomUUID(),label:'Fixture'};
let issue = {id:randomUUID(),title:'Fixture requirement',body:'Existing requirements must remain.',url:'https://linear.app/fixture/issue/TEST-1'};
let writes = 0, failWrite = false, onWrite = null;
const receipts = new Map();
globalThis.requirementsTestProvider = {
  destinations: async () => [destination],
  operation: async (user, workspace, key, input) => {
    assert.equal(user,userId); assert.equal(workspace,workspaceId);
    if (input.action === 'read') return {issue:{...issue}};
    assert.equal(input.action,'update'); assert.equal(input.issueId,issue.id);
    if (receipts.has(key)) return receipts.get(key);
    if (failWrite) throw createError({statusCode:503,statusMessage:'Fixture provider unavailable'});
    writes++; issue = {...issue,body:input.body};
    const result={saved:true,issue:{...issue}};
    receipts.set(key,result);
    await db.insert(schema.externalOperations).values({id:createHash('sha256').update(`${userId}:${workspaceId}:${key}`).digest('hex'),workspaceId,provider:'linear',action:'update',fingerprint:key,destination,state:'complete',result:issue});
    if (onWrite) await onWrite();
    return result;
  },
};
const {requirementAction,publishRequirement}=await import('../server/utils/test-requirements.ts');
const {saveItem}=await import('../server/utils/workspaces.ts');
const plan={kind:'test_plan',summary:'Keep this summary',sources:[],cases:[{id:caseId,title:'Fixture',type:'manual',steps:'Observe',preconditions:'Fixture only',expected:'Old expectation'},{id:randomUUID(),title:'Other',type:'manual',steps:'Keep',preconditions:'',expected:'Untouched'}]};
const propose = version => requirementAction(userId,workspaceId,{action:'propose',itemId,caseId,expectedVersion:version,requestId:randomUUID(),question:'Which message is acceptable?',clarification:'A generic authentication error is acceptable.',expected:'Show generic error and stay signed out in UI.',issueId:issue.id});
const getPlan = async () => (await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.id,itemId)))[0];
const getRecord = async id => (await db.select().from(schema.testRequirements).where(eq(schema.testRequirements.id,id)))[0];
try {
  await db.insert(schema.user).values({id:userId,name:'Temporary requirements verification',email:`requirements-${userId}@example.com`});
  await db.insert(schema.workspaces).values({id:workspaceId,userId,name:'Temporary requirements fixture'});
  await db.insert(schema.workspaceItems).values({id:itemId,workspaceId,title:'Fixture',content:plan});
  await db.insert(schema.workspaceItemVersions).values({id:randomUUID(),itemId,version:1,title:'Fixture',content:plan});
  const draft=await propose(1);
  await db.transaction(async lock => {
    await lock.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`requirement-publish:${workspaceId}`},0))`);
    await assert.rejects(publishRequirement(userId,workspaceId,draft.id,1),e=>e.statusCode===409,'Busy publication returns immediately without occupying the whole pool');
  });
  assert.equal(draft.appliedVersion,null);
  assert.equal((await getPlan()).version,1);
  issue.body += '\nChanged by another person';
  await assert.rejects(publishRequirement(userId,workspaceId,draft.id,1),e=>e.statusCode===409);
  assert.equal(writes,0,'Never overwrite external edits since proposal');
  const fresh=await propose(1);
  failWrite=true;
  await assert.rejects(publishRequirement(userId,workspaceId,fresh.id,1),e=>e.statusCode===503);
  assert.equal((await getRecord(fresh.id)).publishedAt,null);
  assert.equal((await getPlan()).version,1,'Provider failure must not change plan');
  failWrite=false;
  const saved=await publishRequirement(userId,workspaceId,fresh.id,1);
  assert.equal(saved.appliedVersion,2); assert.equal(writes,1);
  const updated=await getPlan();
  assert.equal(updated.content.summary,plan.summary);
  assert.deepEqual(updated.content.cases[1],plan.cases[1]);
  assert.deepEqual(updated.content.cases[0],{...plan.cases[0],expected:fresh.expected});
  assert.ok(updated.content.cases.every(testCase => !Object.hasOwn(testCase,'checksVersion')),'Direct requirement publication preserves the raw legacy parser');
  assert.ok(plan.cases.every(testCase => !Object.hasOwn(testCase,'checksVersion')),'Raw legacy fixture must remain unchanged');
  const originalVersion=(await db.select().from(schema.workspaceItemVersions).where(eq(schema.workspaceItemVersions.itemId,itemId))).find(version=>version.version===1);
  assert.deepEqual(originalVersion.content,plan);
  assert.equal(updated.content.cases[0].expected,fresh.expected);
  assert.ok(issue.body.startsWith('Existing requirements must remain.\nChanged by another person'));
  assert.equal(updated.content.sources[0].itemId,saved.materialId);
  assert.equal((await publishRequirement(userId,workspaceId,fresh.id,1)).appliedVersion,2);
  assert.equal(writes,1,'Publication replay is idempotent');
  const next=await propose(2);
  onWrite=async()=> { await saveItem(userId,workspaceId,{id:itemId,title:'Fixture',content:{...updated.content,summary:'Concurrent edit survives'},expectedVersion:2}); };
  await assert.rejects(publishRequirement(userId,workspaceId,next.id,2),e=>e.statusCode===409);
  assert.ok((await getRecord(next.id)).publishedAt,'Confirmed external success survives local conflict');
  assert.equal((await getRecord(next.id)).appliedVersion,null);
  assert.deepEqual((await getPlan()).content.cases,updated.content.cases.map(testCase=>({...testCase,checksVersion:2})),'Only the ordinary save stamps a new parser version');
  onWrite=null;
  const resumed=await publishRequirement(userId,workspaceId,next.id,3);
  assert.equal(resumed.appliedVersion,4); assert.equal(resumed.materialId,saved.materialId);
  assert.equal(writes,2,'Local resume must not duplicate external write');
  assert.equal((await getPlan()).content.summary,'Concurrent edit survives');
  assert.equal((await getPlan()).content.sources[0].version,2,'Living material document gets a new version');
  // Simulate process loss between confirmed provider receipt and local flag.
  const recover=await propose(4);
  onWrite=async()=> { throw new Error('Simulated process interruption after provider receipt'); };
  await assert.rejects(publishRequirement(userId,workspaceId,recover.id,4));
  assert.equal((await getRecord(recover.id)).publishedAt,null);
  onWrite=null;
  assert.equal((await publishRequirement(userId,workspaceId,recover.id,4)).appliedVersion,5);
  assert.equal(writes,3,'Receipt recovery must not repeat provider write');
  const uncertain=await propose(5);
  await db.insert(schema.externalOperations).values({id:createHash('sha256').update(`${userId}:${workspaceId}:test-requirement:${uncertain.id}`).digest('hex'),workspaceId,provider:'linear',action:'update',fingerprint:'uncertain-fixture',destination,state:'unknown'});
  const bypass=await propose(5);
  await assert.rejects(publishRequirement(userId,workspaceId,bypass.id,5),e=>e.statusCode===409);
  assert.equal(writes,3,'A fresh proposal cannot bypass an uncertain provider write');
  console.log('PASS: Linear conflict, provider failure, exact append, atomic local apply, preserved content, living document, idempotency, partial success and receipt recovery');
} finally {
  await db.delete(schema.user).where(eq(schema.user.id,userId));
  await connection.end(); hooks.deregister();
  delete globalThis.requirementsTestDb; delete globalThis.requirementsTestSchema; delete globalThis.requirementsTestProvider;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { environmentPlanSchema, parseEnvironmentFile } from '../shared/project-environment.ts';
import { sealEnvironment, openEnvironment } from '../server/utils/environment-crypto.ts';
import { EnvironmentManager, validatePlan } from '../infra/codex-worker/environment.mjs';

const plan = { repoUrl:'https://github.com/example/project', root:'/workspace/project', directory:'/workspace/project/app', commit:'a'.repeat(40), command:'npm run dev', port:3000, httpStatus:500, variables:[{name:'DATABASE_URL',reason:'Required for page data',required:true}] };
test('environment scope rejects traversal, runtime injection and duplicate requirements', () => {
  assert.ok(environmentPlanSchema.safeParse(plan).success);
  for (const altered of [{...plan,directory:'/workspace/other'}, {...plan,root:'/workspace/../host'}, {...plan,variables:[...plan.variables,...plan.variables]}, {...plan,variables:[{...plan.variables[0],name:'NODE_OPTIONS'}]}]) {
    assert.equal(environmentPlanSchema.safeParse(altered).success,false);
    assert.throws(()=>validatePlan(altered));
  }
});
test('dotenv import is literal data, never shell expansion, and rejects ambiguous input', () => {
  assert.deepEqual(parseEnvironmentFile('# comment\nexport DATABASE_URL="$(touch nope)"\nTOKEN=abc # note'),{DATABASE_URL:'$(touch nope)',TOKEN:'abc'});
  assert.throws(()=>parseEnvironmentFile('TOKEN=a\nTOKEN=b'));
  assert.throws(()=>parseEnvironmentFile('PATH=/tmp'));
  assert.throws(()=>parseEnvironmentFile('TOKEN="multiline\nvalue"'));
});
test('vault ciphertext authenticates workspace/repo and detects tampering', () => {
  const prior=process.env.ENV_VAULT_KEY; process.env.ENV_VAULT_KEY='test-only-key-'.repeat(4);
  try {
    const values={DATABASE_URL:'private-test-value'}, scope='workspace:repo:test', sealed=sealEnvironment(values,scope);
    assert.ok(!sealed.includes(values.DATABASE_URL));
    assert.deepEqual(openEnvironment(sealed,scope),values);
    assert.throws(()=>openEnvironment(sealed,'other-workspace:repo:test'));
    const parts=sealed.split('.'); parts[3]=(parts[3][0]==='A'?'B':'A')+parts[3].slice(1);
    assert.throws(()=>openEnvironment(parts.join('.'),scope));
  } finally { if(prior===undefined) delete process.env.ENV_VAULT_KEY; else process.env.ENV_VAULT_KEY=prior; }
});
test('configuration reuses a process on retry; secrets use stdin and survive encrypted redaction recovery', async t => {
  const directory=await mkdtemp(join(tmpdir(),'qa-environment-')); t.after(()=>rm(directory,{recursive:true,force:true}));
  const id=randomUUID(),jobId=randomUUID(),attempt=randomUUID(),secret='secret+fixture/with-characters';
  const session={id,status:'ready',codex:{jobId},processes:[]},calls=[];
  let lock=Promise.resolve();
  const sandboxes={leaseMs:300000,owned:()=>session,save:async()=>{},serial:(_id,fn)=>{const next=lock.then(fn);lock=next.catch(()=>{});return next;},execute:async(args,stdin)=>{calls.push({args,stdin});return stdin?JSON.stringify({processId:attempt,commit:plan.commit}):'{"httpStatus":200}';}};
  const manager=new EnvironmentManager({sandboxes,directory,key:'worker-test-key'}); await manager.init();
  const job={id,jobId,owner:'owner',environment:plan};
  await assert.rejects(manager.apply(job,{PATH:secret},attempt),/missing or invalid/);
  assert.equal(calls.length,0);
  await Promise.all([manager.apply(job,{DATABASE_URL:secret},attempt),manager.apply(job,{DATABASE_URL:secret},attempt)]);
  assert.equal(calls.filter(c=>c.stdin).length,1); assert.equal(session.processes.length,1);
  assert.ok(!JSON.stringify(calls.map(c=>c.args)).includes(secret));
  assert.equal(JSON.parse(calls.find(c=>c.stdin).stdin).values.DATABASE_URL,secret);
  assert.ok(!JSON.stringify(session).includes(secret));
  assert.ok(!(await readFile(join(directory,id+'.json'),'utf8')).includes(secret));
  const recovered=new EnvironmentManager({sandboxes,directory,key:'worker-test-key'});await recovered.init();
  assert.deepEqual(recovered.redact(id,{stdout:`${secret} ${Buffer.from(secret).toString('base64')} ${encodeURIComponent(secret)}`}),{stdout:'[redacted] [redacted] [redacted]'});
  await assert.rejects(recovered.remember(id,'https://github.com/other/repo',{}),/another configured/);
  session.codex.jobId=randomUUID();
  await assert.rejects(recovered.apply(job,{DATABASE_URL:secret},randomUUID()),/newer job/);
});

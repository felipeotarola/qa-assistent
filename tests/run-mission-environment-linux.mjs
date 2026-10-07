import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyMissionCheckout, inspectMissionProfile, startMissionEnvironment, healthInside } from '../infra/codex-worker/environment.mjs';

// Explicit physical probe in the owned WSL fixture. Docker has network=none,
// the repository is generated locally, and the value is a synthetic nonce.
const bootstrap = String.raw`
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,chmod,realpath,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
assert.equal(process.env.WSL_DISTRO_NAME,'SynaAutonomy-ff9dd82d1748');assert.equal(process.getuid(),0);
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);const x=JSON.parse(Buffer.concat(chunks));
assert.match(x.id,/^[a-f0-9-]{36}$/);const root='/tmp/syna-env-probe-'+x.id, name='syna-env-'+x.id, sentinel='syna-env-sentinel-'+x.id;
await mkdir(root);assert.equal(await realpath(root),root);await chmod(root,0o777);
const docker=(args,input)=>execFileSync('docker',args,{encoding:'utf8',input,timeout:30000,stdio:['pipe','pipe','pipe']}).trim();
const exec=(args,input)=>docker(['exec','-i',name,...args],input);
const script=(value,input)=>exec(['node','-e','('+value+')()'],JSON.stringify(input));
const image='qa-repo-runner:public',records=[];let cleanup=false;
try{
 docker(['run','-d','--name',sentinel,'--network=none','--memory=64m',image,'sleep','infinity']);
 docker(['run','-d','--name',name,'--runtime=runsc','--network=none','--memory=512m','--pids-limit=128','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user=1000:1000','--tmpfs=/tmp:rw,exec,nosuid,nodev,size=67108864,uid=1000,gid=1000','--mount','type=bind,src='+root+',dst=/workspace','-e','HOME=/workspace',image,'sleep','infinity']);
 const imageDigest=docker(['inspect','--format','{{.Image}}',name]);
 exec(['node','-e',"const f=require('fs');f.mkdirSync('/workspace/repository');const pkg={name:'isolated-probe',version:'1.0.0',scripts:{dev:'node app.cjs'}};f.writeFileSync('/workspace/repository/package.json',JSON.stringify(pkg));f.writeFileSync('/workspace/repository/package-lock.json',JSON.stringify({name:pkg.name,version:pkg.version,lockfileVersion:3,requires:true,packages:{'':pkg}}));f.writeFileSync('/workspace/repository/app.cjs',Buffer.from(process.argv[1],'base64'));",Buffer.from("const http=require('http'),crypto=require('crypto');console.log(process.env.PUBLIC_TEST_KEY);console.error(process.env.PUBLIC_TEST_KEY);http.createServer((q,r)=>r.end(crypto.createHash('sha256').update(process.env.PUBLIC_TEST_KEY||'').digest('hex'))).listen(3219,'0.0.0.0');").toString('base64')]);
 exec(['git','init','/workspace/repository']);exec(['git','-C','/workspace/repository','remote','add','origin','https://github.com/example/project']);exec(['git','-C','/workspace/repository','add','.']);exec(['git','-C','/workspace/repository','-c','user.name=Synthetic fixture','-c','user.email=fixture@example.invalid','commit','-m','Synthetic local fixture']);
 const commit=exec(['git','-C','/workspace/repository','rev-parse','HEAD']);
 const plan={root:'/workspace/repository',directory:'/workspace/repository',repoUrl:'https://github.com/example/project',commit,command:'node app.cjs',port:3219};
 const verified=JSON.parse(script(x.verify,plan));assert.equal(verified.commit,commit);
 const profile={...JSON.parse(script(x.profile,plan)),imageDigest};assert.equal(profile.runtime,'node24');assert.match(profile.packageManagerVersion,/^\d+\.\d+\.\d+$/);assert.match(profile.lockfileSha256,/^[a-f0-9]{64}$/);
 records.push({scenario:'actual-image-manager-lockfile-profile',profile});
 exec(['node','-e',"const f=require('fs');f.mkdirSync('/workspace/repository/apps/web',{recursive:true});f.writeFileSync('/workspace/repository/apps/web/package.json',JSON.stringify({name:'synthetic-child',version:'1.0.0'}))"]);
 const nested=JSON.parse(script(x.profile,{...plan,directory:'/workspace/repository/apps/web'}));assert.equal(nested.installDirectory,plan.root);assert.equal(nested.lockfileSha256,profile.lockfileSha256);
 records.push({scenario:'monorepo-app-uses-exact-repository-lockfile',passed:true});
 assert.throws(()=>script(x.verify,{...plan,commit:'f'.repeat(40)}));assert.throws(()=>script(x.verify,{...plan,repoUrl:'https://github.com/other/project'}));
 exec(['node','-e',"require('fs').appendFileSync('/workspace/repository/app.cjs','\\n//dirty')"]);assert.throws(()=>script(x.verify,plan));exec(['git','-C',plan.root,'checkout','--','app.cjs']);
 records.push({scenario:'wrong-repository-commit-and-tracked-change-denied',passed:true});
 exec(['bash','--noprofile','--norc','-c','cd /workspace/repository && npm ci --ignore-scripts --no-audit --no-fund']);
 docker(['exec','-d',name,'node','-e',"const f=require('fs');let n=0;setInterval(()=>f.writeFileSync('/workspace/writer',String(++n)),10)"]);await delay(150);
 docker(['stop','-t','1',name]);docker(['start',name]);const tick=exec(['node','-e',"console.log(require('fs').readFileSync('/workspace/writer','utf8'))"]);await delay(100);assert.equal(exec(['node','-e',"console.log(require('fs').readFileSync('/workspace/writer','utf8'))"]),tick);script(x.verify,plan);
 assert.deepEqual({...JSON.parse(script(x.profile,plan)),imageDigest},profile);
 records.push({scenario:'all-installer-writers-stopped-before-private-injection',passed:true});
 const synthetic='TEST_ONLY_'+x.id;const input={plan,values:{PUBLIC_TEST_KEY:synthetic},processId:x.id,validUntil:new Date(Date.now()+15000).toISOString()};script(x.start,input);
 let health;for(let i=0;i<20;i++){health=JSON.parse(exec(['node','-e','('+x.health+')()',String(plan.port)]));if(health.httpStatus===200)break;await delay(50)}assert.equal(health.httpStatus,200);
 const body=exec(['node','-e',"fetch('http://127.0.0.1:3219').then(r=>r.text()).then(console.log)"]);assert.equal(body,createHash('sha256').update(synthetic).digest('hex'));
 const processFile=JSON.parse(exec(['node','-e',"console.log(require('fs').readFileSync('/tmp/qa-processes/'+process.argv[1]+'.json','utf8'))",x.id]));assert.equal(processFile.stdout,'');assert.equal(processFile.stderr,'');assert.ok(!JSON.stringify(processFile).includes(synthetic));
 assert.throws(()=>script(x.start,input));assert.throws(()=>script(x.start,{...input,processId:'expired',validUntil:new Date(Date.now()-1).toISOString()}));
 records.push({scenario:'actual-private-stdin-http-probe-no-secret-logs-no-replay',passed:true});
 assert.equal(docker(['inspect','--format','{{.State.Running}}',sentinel]),'true');
}finally{
 for(const value of [name,sentinel]){try{docker(['rm','-f',value])}catch{}}
 for(const value of [name,sentinel])assert.throws(()=>docker(['inspect',value]));
 assert.equal(await realpath(root),root);await rm(root,{recursive:true,force:true});cleanup=true;
}
console.log(JSON.stringify({version:1,at:new Date().toISOString(),distro:process.env.WSL_DISTRO_NAME,models:'none',network:'none',records,cleanup}));
`;
const result = JSON.parse(execFileSync('wsl.exe', ['-d', 'SynaAutonomy-ff9dd82d1748', '--exec', '/opt/syna-autonomy/node/bin/node', '--input-type=module', '-e', bootstrap], {
  input: JSON.stringify({ id: randomUUID(), verify: verifyMissionCheckout.toString(), profile: inspectMissionProfile.toString(), start: startMissionEnvironment.toString(), health: healthInside.toString() }), encoding: 'utf8', timeout: 60000, windowsHide: true,
}));
const artifact = resolve(`.data/autonomy-isolation/mission-environment-linux-${randomUUID()}.json`);
await writeFile(artifact, JSON.stringify({ ...result, sourceHash: createHash('sha256').update(await readFile('infra/codex-worker/environment.mjs')).digest('hex') }, null, 2));
console.log(JSON.stringify({ passed: result.records.length, artifact, models: 'none', network: 'none', cleanup: result.cleanup }));

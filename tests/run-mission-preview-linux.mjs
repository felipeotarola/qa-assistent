import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Real Docker, Chromium/CDP, routing and cleanup in the explicitly owned WSL.
// No model, Vault, shared runtime mutation or fake memory/network prerequisites.
const paths = ['infra/repo-runner/preview.mjs', 'infra/execution/http.mjs', 'infra/execution/admission.mjs', 'infra/browser/policy.mjs', 'shared/mission-execution.mjs', 'shared/mission-environment.mjs', 'shared/environment-plan-identity.mjs'];
const files = Object.fromEntries(await Promise.all(paths.map(async path => [path, await readFile(path, 'utf8')])));
const bootstrap = String.raw`
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,realpath,rm} from 'node:fs/promises';
import {dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
assert.equal(process.env.WSL_DISTRO_NAME,'SynaAutonomy-ff9dd82d1748');assert.equal(process.getuid(),0);
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);const x=JSON.parse(Buffer.concat(chunks));assert.match(x.id,/^[a-f0-9-]{36}$/);
const root='/tmp/syna-preview-probe-'+x.id, name='qa-sandbox-'+x.id, previewName='qa-preview-'+x.id;
const command=(name,args,input)=>execFileSync(name,args,{encoding:'utf8',input,timeout:30000,stdio:['pipe','pipe','pipe']}).trim();
const docker=(args,input)=>command('docker',args,input), records=[], failures=[];
let previews, proxy, socket, cleanup=false, appCreated=false;
const initial={publicBrowser:JSON.parse(docker(['inspect','qa-browser']))[0],rules:command('iptables',['-S','QA_PREVIEW']),previewImage:docker(['image','inspect','--format','{{.Id}}','qa-browser:execution'])};
assert.equal(docker(['ps','-aq','--filter','label=qa.preview=true']),'','Another preview owns the shared slot');
assert.ok(initial.publicBrowser.HostConfig.Memory>0&&initial.publicBrowser.HostConfig.Memory<=2147483648,'Public pool must already be limited to 2 GiB');
assert.ok(!initial.rules.split('\n').some(line=>line.startsWith('-A ')),'Existing preview network rules must be empty');
command('iptables',['-C','DOCKER-USER','-j','QA_PREVIEW']);
assert.equal(docker(['network','inspect','-f','{{.EnableIPv6}}','qa-repo-net']),'false');
assert.equal(command('sysctl',['-n','net.bridge.bridge-nf-call-iptables']),'1');
await mkdir(root);assert.equal(await realpath(root),root);
try{
 for(const [path,content] of Object.entries(x.files)){assert.ok(/^(infra|shared)\/[a-zA-Z0-9_./-]+\.mjs$/.test(path)&&!path.includes('..'));await mkdir(dirname(root+'/'+path),{recursive:true});await writeFile(root+'/'+path,content);}
 const {Previews}=await import(pathToFileURL(root+'/infra/repo-runner/preview.mjs'));
 const {environmentPlanHash}=await import(pathToFileURL(root+'/shared/mission-environment.mjs'));
 const {browserPolicyDigest}=await import(pathToFileURL(root+'/infra/browser/policy.mjs'));
 const app="const h=require('http');let posts=0;h.createServer((q,r)=>{if(q.method==='POST')posts++;r.setHeader('content-type','text/html; charset=utf-8');r.end(q.url==='/stats'?JSON.stringify({posts}):'<!doctype html><html lang=sv><title>Isolerad preview</title><main><h1>Verklig preview fungerar</h1><a href=/details>Visa detaljer</a><p>'+ (q.url==='/details'?'Detaljsidan är läst.':'Start i isolerad miljö.')+'</p></main></html>')}).listen(3229,'0.0.0.0');";
 docker(['run','-d','--name',name,'--runtime=runsc','--network=qa-repo-net','--memory=256m','--memory-swap=256m','--pids-limit=128','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user=1000:1000','qa-repo-runner:public','node','-e',app]);appCreated=true;
 const state={id:x.id,owner:'a'.repeat(64),workspaceId:randomUUID(),status:'ready',expiresAt:Date.now()+240000,processes:[{id:randomUUID(),status:'running'}]};
 const original={version:1,runtime:'physical:preview:'+x.id,missionId:randomUUID(),taskId:randomUUID(),attemptId:randomUUID(),dispatchId:randomUUID(),mandateRevision:1,planRevision:1,requestHash:'a'.repeat(64),deadlineAt:new Date(Date.now()+240000).toISOString()};state.execution=original;
 const environment={version:1,repoUrl:'https://github.com/example/probe',root:'/workspace/repository',directory:'/workspace/repository',commit:'b'.repeat(40),command:'node app.mjs',port:3229,variables:[],processId:state.processes[0].id,httpStatus:200,probeKind:'http',observedAt:new Date().toISOString(),executionProfile:{version:1,runtime:'node24',imageDigest:docker(['inspect','-f','{{.Image}}',name]),packageManager:'npm',packageManagerVersion:'11.5.0',installDirectory:'/workspace/repository',lockfile:'package-lock.json',lockfileSha256:'c'.repeat(64),ignoreScripts:true}};
 const job={jobId:original.dispatchId,id:state.id,owner:state.owner,workspaceId:state.workspaceId,execution:original,environment,environmentExecution:{version:1,phase:'apply',planHash:environmentPlanHash(environment)},status:'completed',cleanup:'retained',executorStopped:true};
 const execution={...original,taskId:randomUUID(),attemptId:randomUUID(),dispatchId:randomUUID()}, expectedEnvironment={jobId:job.jobId,planHash:environmentPlanHash(environment),processId:environment.processId};
 const admissions=[];let revoked=false;
 proxy=createServer((req,res)=>{const route=previews?.match(req.url);if(route)return previews.proxy(req,res,route);res.writeHead(404);res.end();});proxy.on('upgrade',(req,socket,head)=>previews.upgrade(req,socket,head));proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
 previews=new Previews({sandboxes:{sessions:new Map([[state.id,state]])},base:'http://127.0.0.1:'+proxy.address().port,environmentJob:id=>id===job.jobId?job:null,admission:{async admit(value){admissions.push(value);if(revoked)throw Error('Synthetic mandate revoked');}}});
 await previews.init();
 const target=await previews.target(state,{execution,expectedEnvironment});
 const policy={version:1,readOnly:true,allowedOrigins:[target.origin],deadlineAt:original.deadlineAt}, input={execution,expectedEnvironment,policy};
 await assert.rejects(previews.open(state,environment.port,{...input,policy:{...policy,allowedOrigins:['http://172.30.0.254:1']}}),/assigned application origin/);
 assert.equal(docker(['ps','-aq','--filter','name=^'+previewName+'$']),'');
 records.push({scenario:'wrong-preview-origin-denied-before-browser-creation',passed:true});
 const session=await previews.open(state,environment.port,input);assert.equal(session.policyDigest,browserPolicyDigest(policy));assert.equal(session.policyVersion,1);
 const preview=JSON.parse(docker(['inspect',previewName]))[0];assert.equal(preview.HostConfig.Memory,1073741824);assert.equal(preview.Image,initial.previewImage);
 assert.deepEqual(admissions.slice(-3).map(row=>row.operationId),['preview:create','preview:network','preview:session']);
 records.push({scenario:'real-preview-container-and-exact-read-only-session',passed:true,publicMemory:initial.publicBrowser.HostConfig.Memory,previewMemory:preview.HostConfig.Memory,imageDigest:preview.Image});
 socket=new WebSocket(session.connectUrl);await Promise.race([once(socket,'open'),delay(15000).then(()=>{throw Error('CDP connection timed out')})]);
 let sequence=0;const pending=new Map();socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(!m.id)return;const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);});
 const cdp=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method))},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
 const targets=await cdp('Target.getTargets'), page=targets.targetInfos.find(t=>t.type==='page');assert.ok(page);const attached=await cdp('Target.attachToTarget',{targetId:page.targetId,flatten:true});const sid=attached.sessionId;
 await cdp('Page.enable',{},sid);assert.ok(!(await cdp('Page.navigate',{url:target.origin+'/'},sid)).errorText);
 let text='';for(let i=0;i<100;i++){text=(await cdp('Runtime.evaluate',{expression:'document.body?.innerText||""',returnByValue:true},sid)).result.value;if(text.includes('Verklig preview fungerar'))break;await delay(50);}assert.ok(text.includes('Verklig preview fungerar'));
 const capture=await cdp('Page.captureScreenshot',{format:'png'},sid), bytes=Buffer.from(capture.data,'base64');assert.ok(bytes.length>1000);assert.equal(bytes.subarray(1,4).toString(),'PNG');
 await cdp('Runtime.evaluate',{expression:'document.querySelector("a").click()'},sid);
 for(let i=0;i<100;i++){text=(await cdp('Runtime.evaluate',{expression:'document.body?.innerText||""',returnByValue:true},sid)).result.value;if(text.includes('Detaljsidan är läst.'))break;await delay(50);}assert.ok(text.includes('Detaljsidan är läst.'));
 records.push({scenario:'real-cdp-page-navigation-and-png-capture',passed:true,pageText:'Verklig preview fungerar / Detaljsidan är läst.',screenshotSha256:createHash('sha256').update(bytes).digest('hex'),screenshotBytes:bytes.length});
 const post=await cdp('Runtime.evaluate',{expression:'fetch("'+target.origin+'/write",{method:"POST"}).then(()=>"unexpected").catch(()=>"denied")',awaitPromise:true,returnByValue:true},sid);assert.equal(post.result.value,'denied');
 const counts=await (await fetch(target.origin+'/stats')).json();assert.equal(counts.posts,0);
 const outside=await cdp('Page.navigate',{url:'http://172.30.0.254:1/outside'},sid);assert.match(outside.errorText||'',/BLOCKED_BY_CLIENT/);
 records.push({scenario:'browser-policy-blocks-writes-and-other-origins',passed:true,deliveredPostRequests:counts.posts});
 revoked=true;await assert.rejects(previews.authorizeHeartbeat(previews.active),/revoked/);await assert.rejects(previews.open(state,environment.port,input),/revoked/);
 records.push({scenario:'revoked-original-operating-attempt-denies-heartbeat-and-open-replay',passed:true});
 socket.close();socket=null;const closed=await previews.closeBound(state,environment.port,input);assert.equal(closed.confirmed,true);
 const status=await previews.status(state,environment.port,input);assert.equal(status.absent,true);assert.equal(status.cleanupConfirmed,true);
 assert.equal(command('iptables',['-S','QA_PREVIEW']),initial.rules);assert.throws(()=>docker(['inspect',previewName]));
 records.push({scenario:'historical-cleanup-confirms-container-and-network-absence',passed:true});
}catch(error){failures.push({name:error.name,message:String(error.message).replace(/[a-f0-9]{64}/g,'[digest]')});}
finally{
 socket?.close();if(previews?.active)await previews.close(previews.active.id).catch(()=>{});
 if(appCreated){try{docker(['rm','-f',name])}catch{}}
 if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
 try{assert.throws(()=>docker(['inspect',name]));assert.throws(()=>docker(['inspect',previewName]));assert.equal(command('iptables',['-S','QA_PREVIEW']),initial.rules);const current=JSON.parse(docker(['inspect','qa-browser']))[0];assert.equal(current.Id,initial.publicBrowser.Id);assert.equal(current.State.StartedAt,initial.publicBrowser.State.StartedAt);assert.equal(current.HostConfig.Memory,initial.publicBrowser.HostConfig.Memory);cleanup=true;}catch(error){failures.push({name:'CleanupError',message:error.message});}
 assert.equal(await realpath(root),root);await rm(root,{recursive:true,force:true});
}
console.log(JSON.stringify({version:1,at:new Date().toISOString(),distro:process.env.WSL_DISTRO_NAME,models:'none',admission:'synthetic-denial-capable',repository:'synthetic-application-and-saved-binding',network:'assigned-private-preview-only',records,failures,cleanup}));
`;
const id = randomUUID();
const result = JSON.parse(execFileSync('wsl.exe', ['-d', 'SynaAutonomy-ff9dd82d1748', '--exec', '/opt/syna-autonomy/node/bin/node', '--input-type=module', '-e', bootstrap], {
  input: JSON.stringify({ id, files }), encoding: 'utf8', timeout: 180000, windowsHide: true,
}));
const artifact = resolve(`.data/autonomy-isolation/mission-preview-linux-${id}.json`);
await writeFile(artifact, JSON.stringify({ ...result, sourceHashes: Object.fromEntries(Object.entries(files).map(([path, value]) => [path, createHash('sha256').update(value).digest('hex')])), limitations: ['Synthetic saved apply binding; actual prepare/apply and app PostgreSQL consent were not exercised here.', 'Physical browser/container/CDP/policy and cleanup were exercised without model calls.', 'Existing public browser and configured network prerequisites were checked and preserved.'] }, null, 2));
console.log(JSON.stringify({ passed: result.records.length, failed: result.failures.length, artifact, models: 'none', cleanup: result.cleanup }));
if (result.failures.length || !result.cleanup) process.exitCode = 1;

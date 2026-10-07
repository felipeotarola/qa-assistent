// Read-only probe. No imports from the deployed application, no environment
// values in output, no Docker create/exec/start/stop and no HTTP/model request.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { repoHash } from './repo-benchmark-contract.mjs';

export const REPO_WORKER_PROBE = String.raw`
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import assert from 'node:assert/strict'; import {execFileSync} from 'node:child_process';
const root='/opt/syna-autonomy/source', entry=root+'/infra/repo-runner/server.mjs', hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const candidates=fs.readdirSync('/proc').filter(x=>/^[0-9]+$/.test(x)).flatMap(pid=>{try { const argv=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').filter(Boolean); return argv.includes(entry)?[{pid:Number(pid),argv}]:[]; }catch{return []}});
assert.equal(candidates.length,1,'Exactly one owned runner is required'); const process=candidates[0];
assert.deepEqual(process.argv,['/opt/syna-autonomy/node/bin/node',entry]);
const proc='/proc/'+process.pid, stat=fs.readFileSync(proc+'/stat','utf8');
process.startTicks=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]; process.executable=fs.realpathSync(proc+'/exe'); process.executableSha256=hash(fs.readFileSync(process.executable));
const boot=Number(fs.readFileSync('/proc/stat','utf8').match(/^btime ([0-9]+)$/m)?.[1]), hz=Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}));
assert.ok(boot>0&&hz>0);const startedAtMs=(boot+Number(process.startTicks)/hz)*1000;
const sockets=execFileSync('ss',['-H','-ltnp','sport = :58091'],{encoding:'utf8'}).trim().split('\n');
assert.equal(sockets.length,1); assert.ok(sockets[0].includes('127.0.0.1:58091')); assert.ok(sockets[0].includes('pid='+process.pid+','));
const env=Object.fromEntries(fs.readFileSync(proc+'/environ','utf8').split('\0').filter(Boolean).map(x=>{const n=x.indexOf('=');return [x.slice(0,n),x.slice(n+1)]}));
for (const key of ['AUTONOMY_APP_URL','REPO_APP_URL']) assert.equal(env[key],'http://127.0.0.1:58000');
assert.equal(env.REPO_RUNNER_PORT,'58091'); assert.equal(env.REPO_RUNNER_HOST,'127.0.0.1'); assert.equal(env.REPO_RUNNER_DATA,'/var/lib/syna-autonomy/runner'); assert.equal(env.CODEX_ACCESS_MODE,'shared');
assert.ok(!env.NODE_OPTIONS && !env.NODE_PATH,'Unrecorded runtime preload or resolution override');
const files=[]; function capture(full){assert.equal(fs.realpathSync(full),full,'Source file alias denied');const stat=fs.lstatSync(full);assert.ok(stat.isFile()&&!stat.isSymbolicLink());assert.ok(Math.max(stat.mtimeMs,stat.ctimeMs)<=startedAtMs,'Worker source changed after its process started');files.push({path:path.relative(root,full),sha256:hash(fs.readFileSync(full))})}
function walk(dir){assert.equal(fs.realpathSync(dir),dir,'Source directory alias denied');for(const d of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){assert.ok(!d.isSymbolicLink(),'Source symlink denied');const full=path.join(dir,d.name);if(d.isDirectory()){if(d.name!=='node_modules')walk(full)}else if(/\.(?:mjs|cjs|json)$/.test(d.name)){capture(full)}}}
for (const dir of ['infra/repo-runner','infra/codex-worker','infra/execution']) walk(path.join(root,dir));
for (const name of ['mission-execution.mjs','mission-environment.mjs','environment-plan-identity.mjs','preview-handoff.mjs']) capture(root+'/shared/'+name);
capture(root+'/infra/browser/policy.mjs');
files.sort((a,b)=>a.path.localeCompare(b.path));
const image=name=>JSON.parse(execFileSync('docker',['image','inspect',name],{encoding:'utf8'}))[0];
const execution=image(env.EXECUTION_IMAGE||'qa-repo-runner:public'), preview=image(env.PREVIEW_BROWSER_IMAGE||'qa-browser:execution');
assert.match(execution.Id,/^sha256:[a-f0-9]{64}$/);assert.match(preview.Id,/^sha256:[a-f0-9]{64}$/);
const codex=fs.realpathSync('/opt/qa-codex/codex');
assert.equal(fs.readFileSync(proc+'/stat','utf8').slice(fs.readFileSync(proc+'/stat','utf8').lastIndexOf(')')+2).split(' ')[19],process.startTicks,'Runner identity changed during read');
console.log(JSON.stringify({version:1,process,files,sourceSha256:hash(JSON.stringify(files)),executionImage:execution.Id,previewImage:preview.Id,codex:{path:codex,sha256:hash(fs.readFileSync(codex))},callbackOrigin:'http://127.0.0.1:58000',dependencyScope:'Authored worker modules plus Node/Codex binaries and image digests; no third-party Node import is permitted by the separate source review'}));
`;

export const REPO_RESOURCE_PROBE = String.raw`
import {execFileSync} from 'node:child_process';
const rows=execFileSync('docker',['ps','--all','--format','{{json .}}'],{encoding:'utf8'}).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
console.log(JSON.stringify(rows.filter(x=>/^qa-(?:repo|sandbox|preview)-[a-f0-9-]{36}$/.test(x.Names)).map(x=>({name:x.Names,id:x.ID,state:x.State})).sort((a,b)=>a.name.localeCompare(b.name))));
`;

export async function observeRepoWorker(fixture) {
  assert.equal(fixture.runner?.url, 'http://127.0.0.1:58091');
  const linux = JSON.parse(await readFile('.data/autonomy-isolation/linux/fixture.json', 'utf8'));
  assert.match(linux.name, /^SynaAutonomy-[a-f0-9]{12}$/);
  assert.equal(resolve(linux.path), resolve('.data/autonomy-isolation/linux', linux.name));
  const { stdout } = await promisify(execFile)('wsl.exe', ['-d', linux.name, '-u', 'root', '--exec', '/opt/syna-autonomy/node/bin/node', '--input-type=module', '-e', REPO_WORKER_PROBE], { windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  const value = JSON.parse(stdout);
  assert.equal(value.version, 1); assert.ok(value.files.length >= 15);
  assert.equal(value.sourceSha256, repoHash(JSON.stringify(value.files)));
  return { distro: linux.name, ...value };
}

export async function observeRepoResources(fixture) {
  assert.equal(fixture.runner?.url, 'http://127.0.0.1:58091');
  const linux = JSON.parse(await readFile('.data/autonomy-isolation/linux/fixture.json', 'utf8'));
  assert.match(linux.name, /^SynaAutonomy-[a-f0-9]{12}$/);
  assert.equal(resolve(linux.path), resolve('.data/autonomy-isolation/linux', linux.name));
  const { stdout } = await promisify(execFile)('wsl.exe', ['-d', linux.name, '-u', 'root', '--exec', '/opt/syna-autonomy/node/bin/node', '--input-type=module', '-e', REPO_RESOURCE_PROBE], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  return JSON.parse(stdout);
}

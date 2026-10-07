import { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { environmentPlanIdentity } from '../../shared/environment-plan-identity.mjs';
import { environmentPlanHash, missionEnvironmentExecution } from '../../shared/mission-environment.mjs';
import { sameExecution } from '../execution/admission.mjs';
export const allowedName = name => /^[A-Z][A-Z0-9_]{0,99}$/.test(name) && !/^(PATH|HOME|SHELL|BASH_ENV|ENV|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|PYTHONPATH|PYTHONHOME|JAVA_TOOL_OPTIONS|GIT_.*|npm_config_.*)$/i.test(name);
export function validatePlan(value) {
  if (!value || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(value.repoUrl || '')) throw new Error('Public repository URL required');
  for (const path of [value.root, value.directory]) if (typeof path !== 'string' || !/^\/workspace\/[\w./-]+$/.test(path) || path.split('/').includes('..')) throw new Error('Invalid project directory');
  if (value.directory !== value.root && !value.directory.startsWith(value.root + '/')) throw new Error('Project must belong to repository');
  if (typeof value.command !== 'string' || !value.command || value.command.length > 2000 || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) throw new Error('Start command and port required');
  if (!Array.isArray(value.variables) || value.variables.length > 30 || value.variables.some(v => !allowedName(v.name) || typeof v.reason !== 'string' || !v.reason || v.reason.length > 300 || typeof v.required !== 'boolean') || new Set(value.variables.map(v => v.name)).size !== value.variables.length) throw new Error('Invalid environment requirements');
  return { repoUrl: value.repoUrl, root: value.root, directory: value.directory, command: value.command, port: value.port, variables: value.variables.map(({ name, reason, required }) => ({ name, reason, required })) };
}

// Runs inside the assigned container. Values arrive on stdin, never in argv or logs.
export function configureInside() {
  const fs = require('node:fs'), cp = require('node:child_process');
  const input = JSON.parse(fs.readFileSync(0, 'utf8')), p = input.plan;
  const realRoot = fs.realpathSync(p.root), realDir = fs.realpathSync(p.directory);
  if (realRoot !== p.root || realDir !== p.directory || (realDir !== realRoot && !realDir.startsWith(realRoot + '/'))) throw Error('Project path changed');
  const git = args => cp.execFileSync('git', ['-C', realRoot, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim();
  const url = git(['config','--get','remote.origin.url']).replace(/\/$/,'').replace(/\.git$/,'');
  if (url !== p.repoUrl || git(['rev-parse','--show-toplevel']) !== realRoot) throw Error('Repository identity changed');
  const commit = git(['rev-parse','HEAD']);
  if (p.commit && p.commit !== commit) throw Error('Revision changed; inspect again before applying secrets');
  if (input.action === 'inspect') { console.log(JSON.stringify({ commit })); return; }
  if (fs.existsSync(`/tmp/qa-processes/${input.newProcessId}.json`)) { console.log(JSON.stringify({processId:input.newProcessId,commit})); return; }
  fs.mkdirSync('/tmp/qa-processes', { recursive: true });
  // Reserve before spawning: an uncertain retry must never launch a second server.
  fs.writeFileSync(`/tmp/qa-processes/${input.newProcessId}.json`, JSON.stringify({id:input.newProcessId,status:'starting',pid:null,stdout:'',stderr:'',exitCode:null}), { flag:'wx', mode:0o600 });
  if (input.processId) {
    const file = `/tmp/qa-processes/${input.processId}.json`;
    if (fs.existsSync(file)) { const state = JSON.parse(fs.readFileSync(file, 'utf8')); if (['running','starting'].includes(state.status) && state.pid > 1) try { process.kill(-state.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
  }
  // Supervisor receives a private pipe. The repository is trusted by the user's
  // explicit "save and continue" action; it can access these values at runtime.
  const script = `const fs=require('node:fs'),cp=require('node:child_process'); const x=JSON.parse(fs.readFileSync(0,'utf8')); const d='/tmp/qa-processes'; fs.mkdirSync(d,{recursive:true}); const f=d+'/'+x.id+'.json'; const s={id:x.id,pid:null,status:'starting',stdout:'',stderr:'',exitCode:null}; const redact=t=>Object.values(x.values).filter(Boolean).reduce((s,v)=>s.split(v).join('[redacted]'),String(t)); const save=()=>{s.updatedAt=new Date().toISOString();fs.writeFileSync(f+'.tmp',JSON.stringify(s),{mode:0o600});fs.renameSync(f+'.tmp',f)};save();const c=cp.spawn('bash',['-lc',x.command],{cwd:x.directory,env:{...process.env,...x.values},detached:true,stdio:['ignore','pipe','pipe']});s.pid=c.pid;s.status='running';save();for(const k of ['stdout','stderr'])c[k].on('data',b=>{s[k]=redact((s[k]+b.toString()).slice(-32000))});const timer=setInterval(save,500);c.on('error',()=>{s.stderr='Configured process could not start'});c.on('close',code=>{clearInterval(timer);s.status='completed';s.exitCode=code??137;save()});`;
  const child = cp.spawn(process.execPath, ['-e', script], { detached: true, stdio: ['pipe','ignore','ignore'] });
  child.stdin.end(JSON.stringify({ id: input.newProcessId, values: input.values, command: p.command, directory: realDir }));
  child.unref(); console.log(JSON.stringify({ processId: input.newProcessId, commit }));
}
export function healthInside() {
  const port = Number(process.argv[1]);
  fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    .then(r => { console.log(JSON.stringify({ httpStatus: r.status })); r.body?.cancel(); })
    .catch(() => console.log(JSON.stringify({ httpStatus: null })));
}

// A trusted script supplied as argv, not loaded from the repository. It checks
// the fresh checkout again after all installers and their descendants stopped.
export function verifyMissionCheckout() {
  const fs = require('node:fs'), cp = require('node:child_process');
  const p = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (p.root !== '/workspace/repository' || fs.realpathSync(p.root) !== p.root || fs.realpathSync(p.directory) !== p.directory || (p.directory !== p.root && !p.directory.startsWith(p.root + '/'))) throw Error('Unexpected project path');
  const git = args => cp.execFileSync('git', ['-C', p.root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (git(['rev-parse', '--show-toplevel']) !== p.root || git(['config', '--get', 'remote.origin.url']) !== p.repoUrl || git(['rev-parse', 'HEAD']) !== p.commit) throw Error('Frozen repository identity changed');
  if (git(['status', '--porcelain', '--untracked-files=no']) || git(['diff', '--name-only', 'HEAD'])) throw Error('Tracked project files changed');
  console.log(JSON.stringify({ repoUrl: p.repoUrl, commit: p.commit, root: p.root, directory: p.directory }));
}

export function inspectMissionProfile() {
  const fs = require('node:fs'), cp = require('node:child_process'), crypto = require('node:crypto'), pathModule = require('node:path');
  const plan = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (process.versions.node.split('.')[0] !== '24' || fs.realpathSync(plan.directory) !== plan.directory) throw Error('Node24 and a physical project directory required');
  const app = JSON.parse(fs.readFileSync(plan.directory + '/package.json', 'utf8'));
  let installDirectory = plan.directory, pkg, packageManager, lockfile;
  for (;;) {
    if (fs.realpathSync(installDirectory) !== installDirectory) throw Error('Install directory must be physical');
    if (fs.existsSync(installDirectory + '/package.json')) {
      pkg = JSON.parse(fs.readFileSync(installDirectory + '/package.json', 'utf8'));
      const requested = app.packageManager || pkg.packageManager;
      packageManager = requested?.startsWith('pnpm@') || (!requested && fs.existsSync(installDirectory + '/pnpm-lock.yaml')) ? 'pnpm' : 'npm';
      if (requested && !requested.startsWith(packageManager + '@')) throw Error('Unsupported package manager');
      lockfile = packageManager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml';
      if (fs.existsSync(installDirectory + '/' + lockfile)) break;
    }
    if (installDirectory === plan.root) throw Error('Locked Node project required');
    installDirectory = pathModule.dirname(installDirectory);
    if (installDirectory !== plan.root && !installDirectory.startsWith(plan.root + '/')) throw Error('Lockfile escaped repository');
  }
  const version = cp.execFileSync(packageManager, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd: '/tmp', timeout: 10000 }).trim();
  if (!/^\d+\.\d+\.\d+$/.test(version) || [app.packageManager, pkg.packageManager].some(requested => requested && requested.split('+')[0] !== packageManager + '@' + version)) throw Error('Pinned package manager is not installed');
  const path = installDirectory + '/' + lockfile;
  if (fs.realpathSync(path) !== path || fs.statSync(path).size > 16000000) throw Error('A bounded physical lockfile is required');
  console.log(JSON.stringify({ version: 1, runtime: 'node24', packageManager, packageManagerVersion: version, installDirectory, lockfile, lockfileSha256: crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex'), ignoreScripts: true }));
}

// Values enter only this trusted stdin pipe. No application logs are persisted
// for autonomous credential-bearing processes, including split/encoded values.
export function startMissionEnvironment() {
  const fs = require('node:fs'), cp = require('node:child_process');
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (Date.now() >= Date.parse(input.validUntil)) throw Error('Environment release expired');
  const path = '/tmp/qa-processes/' + input.processId + '.json';
  fs.mkdirSync('/tmp/qa-processes', { recursive: true });
  fs.writeFileSync(path, JSON.stringify({ id: input.processId, status: 'starting', pid: null, stdout: '', stderr: '', exitCode: null }), { flag: 'wx', mode: 0o600 });
  const script = `const fs=require('node:fs'),cp=require('node:child_process');const x=JSON.parse(fs.readFileSync(0,'utf8'));if(Date.now()>=Date.parse(x.validUntil))process.exit(125);const f='/tmp/qa-processes/'+x.processId+'.json';const s={id:x.processId,status:'starting',pid:null,stdout:'',stderr:'',exitCode:null};const save=()=>{s.updatedAt=new Date().toISOString();fs.writeFileSync(f+'.tmp',JSON.stringify(s),{mode:0o600});fs.renameSync(f+'.tmp',f)};const c=cp.spawn('bash',['--noprofile','--norc','-c',x.plan.command],{cwd:x.plan.directory,env:{PATH:process.env.PATH,HOME:'/workspace',CI:'true',...x.values},detached:true,stdio:'ignore'});s.pid=c.pid;s.status='running';save();c.on('error',()=>{s.status='interrupted';s.exitCode=null;save()});c.on('close',code=>{s.status='completed';s.exitCode=code??137;save()});`;
  const child = cp.spawn(process.execPath, ['-e', script], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.end(JSON.stringify(input)); child.unref();
  console.log(JSON.stringify({ processId: input.processId }));
}

export class EnvironmentManager {
  constructor({ sandboxes, directory, key = process.env.REPO_RUNNER_KEY, appUrl = process.env.AUTONOMY_APP_URL, secret = process.env.INTERNAL_API_SECRET, fetch: request = globalThis.fetch }) { Object.assign(this, { sandboxes, directory, appUrl, secret, request }); this.key = createHash('sha256').update(key || '').digest(); this.values = new Map(); }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.directory)) if (/^[a-f0-9-]{36}\.json$/.test(file)) {
      const id = file.slice(0,-5), data = JSON.parse(await readFile(`${this.directory}/${file}`, 'utf8'));
      const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(data.iv,'base64')); cipher.setAAD(Buffer.from(id)); cipher.setAuthTag(Buffer.from(data.tag,'base64'));
      this.values.set(id, JSON.parse(Buffer.concat([cipher.update(Buffer.from(data.data,'base64')),cipher.final()]).toString()));
    }
    this.sandboxes.redact = (id, value) => this.redact(id, value);
    this.sandboxes.forgetCredentials = id => this.values.delete(id);
  }
  redact(id, value) {
    const values = Object.values(this.values.get(id)?.values || {}).filter(Boolean).flatMap(v => [v, Buffer.from(v).toString('base64'), encodeURIComponent(v)]).sort((a,b)=>b.length-a.length);
    const walk = v => typeof v === 'string' ? values.reduce((s,secret)=>s.split(secret).join('[redacted]'),v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x)])) : v;
    return walk(value);
  }
  async remember(id, repoUrl, values) {
    const existing = this.values.get(id);
    if (existing && existing.repoUrl !== repoUrl) throw new Error('This sandbox is bound to another configured repository');
    // Keep former values in the redaction set when a key is rotated.
    const stored = { repoUrl, values: { ...existing?.values, ...Object.fromEntries(Object.values(values).map((v,i)=>[randomUUID()+i,v])) } };
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv); cipher.setAAD(Buffer.from(id));
    const data = Buffer.concat([cipher.update(JSON.stringify(stored)),cipher.final()]);
    const path = `${this.directory}/${id}.json`; await writeFile(path+'.tmp',JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}),{mode:0o600}); await rename(path+'.tmp',path); this.values.set(id,stored);
  }
  async inspect(job, input) {
    const plan = validatePlan(input);
    const output = await this.sandboxes.execute(['exec','-i',`qa-sandbox-${job.id}`,'node','-e',`(${configureInside.toString()})()`], JSON.stringify({ action:'inspect',plan }));
    const { commit } = JSON.parse(output);
    const checked = await this.health(job.id,plan.port);
    return { ...plan, commit, httpStatus: checked.httpStatus, ...(input.processId ? { processId: input.processId } : {}) };
  }
  async health(id, port) { return JSON.parse(await this.sandboxes.execute(['exec',`qa-sandbox-${id}`,'node','-e',`(${healthInside.toString()})()`,String(port)])); }
  async apply(job, values, attemptId) {
    const plan = job.environment;
    if (!plan) throw new Error('No verified environment plan');
    validatePlan(plan);
    const names = new Set(plan.variables.map(v=>v.name));
    if (!values || Object.entries(values).some(([k,v])=>!names.has(k)||!allowedName(k)||typeof v!=='string'||!v||v.length>4000||v.includes('\0')) || plan.variables.some(v=>v.required&&!values[v.name])) throw new Error('Required configuration is missing or invalid');
    const newProcessId = attemptId;
    await this.sandboxes.serial(job.id, async () => {
    const s = this.sandboxes.owned(job.id,job.owner);
    if (s.status !== 'ready') throw new Error('Sandbox stopped or expired; inspect before continuing');
    if (s.codex?.jobId !== job.jobId) throw new Error('A newer job owns this environment');
    await this.remember(job.id,plan.repoUrl,values);
    if (!s.processes.some(p=>p.id===newProcessId)) {
      const output = await this.sandboxes.execute(['exec','-i',`qa-sandbox-${job.id}`,'node','-e',`(${configureInside.toString()})()`],JSON.stringify({action:'apply',plan,values,processId:plan.processId,newProcessId}));
      JSON.parse(output);
      s.processes.push({id:newProcessId,status:'running',exitCode:null,stdout:'',stderr:''}); s.expiresAt=Date.now()+this.sandboxes.leaseMs; await this.sandboxes.save(s);
    }
    });
    let health = { httpStatus: null };
    for (let i=0;i<6;i++) { health = await this.health(job.id,plan.port); if (health.httpStatus>=200 && health.httpStatus<400) break; await new Promise(r=>setTimeout(r,2000)); }
    return { ...plan, processId:newProcessId, httpStatus:health.httpStatus };
  }

  missionState(job, lifecycle) {
    const state = this.sandboxes.owned(job.id, job.owner);
    sameExecution(state.execution, job.execution);
    if (state.workspaceId !== job.workspaceId || state.status !== 'ready' || !lifecycle.active() || Date.now() >= Date.parse(job.execution.deadlineAt)) throw new Error('Environment execution is no longer active');
    return state;
  }
  async missionCommand(job, lifecycle, operationId, args, stdin, privateInput = false) {
    this.missionState(job, lifecycle);
    job.environmentJournal ||= {};
    if (job.environmentJournal[operationId]) throw new Error('Environment command outcome already recorded; automatic replay denied');
    job.environmentJournal[operationId] = { state: 'unknown' }; await lifecycle.save();
    await lifecycle.authorize(operationId, 'sandbox.command', { args, ...(privateInput ? { planHash: job.environmentExecution.planHash, privateInput: true } : { stdin: stdin ?? null }) });
    this.missionState(job, lifecycle);
    // The timeout also bounds installation. A failed/unknown Docker receipt is
    // followed by physical container cleanup, never a blind command replay.
    const output = await this.sandboxes.execute(args, stdin, { timeoutMs: 180000 });
    job.environmentJournal[operationId] = { state: 'completed' }; await lifecycle.save();
    return output;
  }
  async checkoutMission(job, lifecycle) {
    const execution = missionEnvironmentExecution(job.environmentExecution);
    const plan = execution.phase === 'apply' ? execution.plan : { ...execution, root: '/workspace/repository', directory: '/workspace/repository' };
    if (plan.root !== '/workspace/repository') throw new Error('Frozen environment must use the isolated repository root');
    const exec = (id, args, stdin) => this.missionCommand(job, lifecycle, id, ['exec', '-i', `qa-sandbox-${job.id}`, ...args], stdin);
    await exec('environment:empty', ['node', '-e', "const f=require('fs');if(f.existsSync('/workspace/repository'))throw Error('Fresh checkout required')"]);
    await exec('environment:init', ['git', 'init', '--', plan.root]);
    await exec('environment:remote', ['git', '-C', plan.root, 'remote', 'add', 'origin', plan.repoUrl]);
    await exec('environment:fetch', ['git', '-C', plan.root, '-c', 'core.hooksPath=/dev/null', 'fetch', '--depth=1', 'origin', plan.commit]);
    await exec('environment:checkout', ['git', '-C', plan.root, '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', plan.commit]);
    await exec('environment:verify-checkout', ['node', '-e', `(${verifyMissionCheckout.toString()})()`], JSON.stringify(plan));
    return plan;
  }
  async prepareMission(job, lifecycle) {
    return this.sandboxes.serial(job.id, () => this.checkoutMission(job, lifecycle));
  }
  async missionProfile(job, lifecycle, plan, suffix) {
    const imageDigest = (await this.missionCommand(job, lifecycle, `environment:image:${suffix}`, ['inspect', '--format', '{{.Image}}', `qa-sandbox-${job.id}`])).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) throw new Error('Container image identity is unavailable');
    const profile = JSON.parse(await this.missionCommand(job, lifecycle, `environment:profile:${suffix}`, ['exec', '-i', `qa-sandbox-${job.id}`, 'node', '-e', `(${inspectMissionProfile.toString()})()`], JSON.stringify(plan)));
    return environmentPlanIdentity({ ...plan, executionProfile: { ...profile, imageDigest } }).executionProfile;
  }
  async inspectMission(job, input, lifecycle) {
    const expected = missionEnvironmentExecution(job.environmentExecution), plan = validatePlan(input);
    if (expected.phase !== 'prepare' || plan.root !== '/workspace/repository' || plan.repoUrl !== expected.repoUrl) throw new Error('Plan does not match the inspected repository');
    const frozen = { ...plan, commit: expected.commit };
    return this.sandboxes.serial(job.id, async () => {
      const key = `environment:verify-plan:${environmentPlanHash(frozen)}`;
      await this.missionCommand(job, lifecycle, key, ['exec', '-i', `qa-sandbox-${job.id}`, 'node', '-e', `(${verifyMissionCheckout.toString()})()`], JSON.stringify(frozen));
      const executionProfile = await this.missionProfile(job, lifecycle, frozen, environmentPlanHash(frozen));
      return { ...frozen, executionProfile, httpStatus: null, probeKind: 'identity', observedAt: new Date().toISOString() };
    });
  }
  async verifyApprovedMission(job, lifecycle) {
    const request = missionEnvironmentExecution(job.environmentExecution);
    if (request.phase !== 'prepare' || !request.approvedPlan) throw new Error('Approved preparation required');
    const { plan, planHash } = request.approvedPlan;
    const observation = await this.inspectMission(job, { ...plan, variables: plan.variables.map(v => ({ ...v, reason: 'Godkänd miljöplan' })) }, lifecycle);
    if (environmentPlanHash(observation) !== planHash) throw new Error('Approved preparation execution profile changed');
    // Refresh authority after awaited physical profile inspection, before a new
    // identity receipt can be published. Never inherit old health/process data.
    await lifecycle.authorize('environment:approved-plan:publish', 'sandbox.command', { planHash });
    this.missionState(job, lifecycle);
    return observation;
  }
  async releaseMission(job) {
    const request = missionEnvironmentExecution(job.environmentExecution);
    if (request.phase !== 'apply' || !this.appUrl || typeof this.secret !== 'string' || this.secret.length < 32) throw new Error('Environment release is unavailable');
    const url = new URL(this.appUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Invalid environment release endpoint');
    url.pathname = '/api/internal/environment-release';
    let result;
    try {
      const response = await this.request(url, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ execution: job.execution, resourceId: job.id, operationId: 'environment:release', planHash: request.planHash, sourceSetupJobId: request.sourceSetupJobId }) });
      if (!response.ok || !response.body) throw Error('Denied');
      const reader = response.body.getReader(); let size = 0; const chunks = [];
      try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 150000) throw Error('Oversized'); chunks.push(next.value); } }
      finally { await reader.cancel().catch(() => {}); }
      result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new Error('Environment release denied or unavailable'); }
    if (!result || Object.keys(result).length !== 3 || !['values', 'validUntil', 'releaseId'].every(key => Object.hasOwn(result, key)) || typeof result.validUntil !== 'string' || typeof result.releaseId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(result.releaseId)) throw new Error('Invalid environment release receipt');
    const expires = Date.parse(result.validUntil);
    if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.parse(job.execution.deadlineAt)) throw new Error('Environment release expired or widened');
    const names = new Set(request.plan.variables.map(v => v.name));
    if (!result.values || Array.isArray(result.values) || typeof result.values !== 'object' || Object.entries(result.values).some(([name, value]) => !names.has(name) || !allowedName(name) || typeof value !== 'string' || !value || value.length > 4000 || value.includes('\0')) || request.plan.variables.some(v => v.required && !result.values[v.name])) throw new Error('Invalid environment release values');
    if (request.consent === null && Object.keys(result.values).length) throw new Error('Secret release requires consent');
    return result;
  }
  async applyMission(job, lifecycle) {
    const request = missionEnvironmentExecution(job.environmentExecution);
    if (request.phase !== 'apply' || environmentPlanHash(request.plan) !== request.planHash) throw new Error('Invalid frozen apply plan');
    return this.sandboxes.serial(job.id, async () => {
      const plan = await this.checkoutMission(job, lifecycle), name = `qa-sandbox-${job.id}`;
      const exec = (id, args, stdin) => this.missionCommand(job, lifecycle, id, ['exec', '-i', name, ...args], stdin);
      const profile = await this.missionProfile(job, lifecycle, plan, 'before-install');
      if (environmentPlanHash({ ...plan, executionProfile: profile }) !== request.planHash) throw new Error('Runtime, image, package manager or lockfile changed');
      const command = profile.packageManager === 'npm' ? ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'] : ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile'];
      await exec('environment:install:0', ['timeout', '150', 'bash', '--noprofile', '--norc', '-c', 'cd -- "$1" && shift && exec "$@"', 'syna-install', profile.installDirectory, ...command]);
      // Docker stop waits for all container processes, including detached
      // installer descendants. No old writer survives the restart boundary.
      await this.missionCommand(job, lifecycle, 'environment:stop-writers', ['stop', '-t', '3', name]);
      await this.missionCommand(job, lifecycle, 'environment:restart-clean', ['start', name]);
      await exec('environment:verify-final', ['node', '-e', `(${verifyMissionCheckout.toString()})()`], JSON.stringify(plan));
      const finalProfile = await this.missionProfile(job, lifecycle, plan, 'after-install');
      if (environmentPlanHash({ ...plan, executionProfile: finalProfile }) !== request.planHash) throw new Error('Frozen execution profile changed after installation');
      // Persist only the fact that this scope may contain credentials. After a
      // worker restart its generic shell/file APIs must stay closed even though
      // the in-memory redaction values are deliberately gone.
      const boundState = this.missionState(job, lifecycle); boundState.credentialBound = true; await this.sandboxes.save(boundState);
      if (job.environmentJournal['environment:release']) throw new Error('Environment release outcome already recorded');
      job.environmentJournal['environment:release'] = { state: 'unknown' }; await lifecycle.save();
      this.missionState(job, lifecycle);
      const release = await this.releaseMission(job);
      job.environmentJournal['environment:release'] = { state: 'completed', releaseId: release.releaseId }; await lifecycle.save();
      // Memory only. Autonomous values are never written to the manual vault
      // cache, journal, callback, argv, errors or process output files.
      this.values.set(job.id, { repoUrl: plan.repoUrl, values: { ...release.values } });
      const processId = job.execution.attemptId;
      await this.missionCommand(job, lifecycle, 'environment:start', ['exec', '-i', name, 'node', '-e', `(${startMissionEnvironment.toString()})()`], JSON.stringify({ plan, values: release.values, processId, validUntil: release.validUntil }), true);
      const state = this.missionState(job, lifecycle);
      state.processes.push({ id: processId, status: 'running', exitCode: null, stdout: '', stderr: '' }); state.expiresAt = Math.min(Date.parse(job.execution.deadlineAt), Date.now() + this.sandboxes.leaseMs); await this.sandboxes.save(state);
      let health = { httpStatus: null };
      for (let index = 0; index < 6; index++) {
        health = JSON.parse(await exec(`environment:health:${index}`, ['node', '-e', `(${healthInside.toString()})()`, String(plan.port)]));
        if (health.httpStatus >= 200 && health.httpStatus < 400) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      return { ...environmentPlanIdentity(plan), variables: plan.variables.map(v => ({ ...v, reason: 'Godkänd miljöplan' })), processId, httpStatus: health.httpStatus, probeKind: 'http', observedAt: new Date().toISOString() };
    });
  }
}

import { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
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

export class EnvironmentManager {
  constructor({ sandboxes, directory, key = process.env.REPO_RUNNER_KEY }) { Object.assign(this, { sandboxes, directory }); this.key = createHash('sha256').update(key || '').digest(); this.values = new Map(); }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.directory)) if (/^[a-f0-9-]{36}\.json$/.test(file)) {
      const id = file.slice(0,-5), data = JSON.parse(await readFile(`${this.directory}/${file}`, 'utf8'));
      const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(data.iv,'base64')); cipher.setAAD(Buffer.from(id)); cipher.setAuthTag(Buffer.from(data.tag,'base64'));
      this.values.set(id, JSON.parse(Buffer.concat([cipher.update(Buffer.from(data.data,'base64')),cipher.final()]).toString()));
    }
    this.sandboxes.redact = (id, value) => this.redact(id, value);
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
}

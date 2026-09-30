import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { validId } from '../execution/store.mjs';
import { SandboxStorage } from '../execution/storage.mjs';
import { SandboxTemplates, seedTemplateCommand } from './templates.mjs';

const docker = (args, input) => new Promise((resolve, reject) => {
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout = (stdout + value).slice(-40000000); });
  child.stderr.on('data', value => { stderr = (stderr + value).slice(-4000); });
  child.on('error', reject); child.on('close', code => code ? reject(new Error(stderr || `Container command exited ${code}`)) : resolve(stdout));
  child.stdin.on('error', () => {}); child.stdin.end(input);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30000); child.on('close', () => clearTimeout(timeout));
});
export const sandboxPath = value => {
  if (typeof value !== 'string' || value.length > 1000 || value.includes('\0')) throw new Error('Invalid sandbox path');
  const path = value.startsWith('/') ? value : `/workspace/${value}`;
  if (path !== '/workspace' && !path.startsWith('/workspace/') && !path.startsWith('/tmp/')) throw new Error('Files must be inside /workspace or /tmp');
  if (path.split('/').includes('..')) throw new Error('Parent paths are not permitted');
  return path;
};
export class Sandboxes {
  constructor({ directory, events, budget, execute = docker, leaseMs = 300000, storage = new SandboxStorage(`${directory}/disks`, 8) }) {
    Object.assign(this, { directory, events, budget, execute, leaseMs, storage }); this.sessions = new Map(); this.locks = new Map();
    this.templates = new SandboxTemplates(`${directory}/templates`);
  }
  async serial(id, operation) {
    const pending = (this.locks.get(id) || Promise.resolve()).catch(() => {}).then(operation); this.locks.set(id, pending);
    try { return await pending; } finally { if (this.locks.get(id) === pending) this.locks.delete(id); }
  }
  async save(session) {
    session.updatedAt = new Date().toISOString();
    const file = `${this.directory}/${session.id}.json`;
    await writeFile(file + '.tmp', JSON.stringify(session), { mode: 0o600 }); await rename(file + '.tmp', file);
    await this.events.publish(session.id, 'sandbox', 'progress', this.view(session));
  }
  view(s) {
    const visible = { ...s }; delete visible.owner;
    let remaining = 64000;
    visible.processes = s.processes.slice(-8).reverse().map(process => {
      const stderr = process.stderr.slice(-Math.min(16000, remaining)); remaining -= stderr.length;
      const stdout = remaining ? process.stdout.slice(-Math.min(32000, remaining)) : ''; remaining -= stdout.length;
      return { ...process, stdout, stderr };
    }).reverse();
    return visible;
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.directory)) if (/^[a-f0-9-]{36}\.json$/.test(file)) {
      const s = JSON.parse(await readFile(`${this.directory}/${file}`, 'utf8')); this.sessions.set(s.id, s);
      // Do not replay commands after a worker restart. Preserve the filesystem only.
      if (!['deleted', 'expired', 'stopped'].includes(s.status)) {
        try { await this.execute(['stop', '-t', '3', `qa-sandbox-${s.id}`]); }
        catch (error) { if (!error.message.includes('No such container')) throw error; s.containerCreated = false; }
        s.status = 'stopped'; s.message = 'Workern startades om. Filer finns kvar; processer måste startas uttryckligen.';
        for (const p of s.processes) if (p.status !== 'completed') { p.status = 'interrupted'; p.exitCode = null; }
        await this.save(s);
      }
    }
  }
  owned(id, owner) { const s = this.sessions.get(id); if (!s || s.owner !== owner) throw new Error('Sandbox not found'); return s; }
  async rpc(input) {
    if (!validId(input.id) || typeof input.owner !== 'string' || !/^[a-f0-9]{64}$/.test(input.owner) || !validId(input.workspaceId)) throw new Error('Invalid sandbox ownership');
    return this.serial(input.id, async () => {
      let s = this.sessions.get(input.id);
      if (s && (s.owner !== input.owner || s.workspaceId !== input.workspaceId)) throw new Error('Sandbox not found');
      const name = `qa-sandbox-${input.id}`;
      const exec = (args, stdin) => this.execute(['exec', '-i', name, ...args], stdin);
      if (input.action === 'ensure') {
        const seedFiles = input.templateKey ? await this.templates.get(input.templateKey) : null;
        if (s && ['deleted', 'expired'].includes(s.status)) throw new Error('Sandbox lease ended. Files are unavailable. Delete the Eve sandbox handle before creating a new environment.');
        if (s?.seededTemplateKey && input.templateKey && s.seededTemplateKey !== input.templateKey) throw new Error('Sandbox template changed; start a new environment');
        if (!s) {
          if ([...this.sessions.values()].filter(s => !['deleted', 'expired'].includes(s.status)).length >= 10) throw new Error('Sandbox storage capacity reached; close an unused environment');
          s = { id: input.id, workspaceId: input.workspaceId, owner: input.owner, status: 'starting', createdAt: new Date().toISOString(), processes: [], message: 'Startar isolerad arbetsmiljö', expiresAt: Date.now() + this.leaseMs }; this.sessions.set(s.id, s); await this.save(s);
        }
        if (s.status !== 'ready') {
          if (!this.budget.reserve(s.id, 1536)) { s.status = 'waiting'; s.message = 'Väntar på VPS-kapacitet. Försök igen när en pågående körning är klar.'; await this.save(s); throw new Error(s.message); }
          try {
            const mount = await this.storage.prepare(s.id);
            if (s.containerCreated) await this.execute(['start', name]);
            else {
              await this.execute(['run', '-d', '--runtime=runsc', '--name', name, '--label', 'qa.sandbox=true', '--init', '--network=qa-repo-net', '--dns=1.1.1.1', '--mount', 'type=bind,src=/opt/qa-repo-runner/resolv.conf,dst=/etc/resolv.conf,readonly', '--memory=1536m', '--memory-swap=1536m', '--cpus=1', '--pids-limit=256', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=1000:1000', '--tmpfs=/tmp:rw,exec,nosuid,nodev,size=268435456,uid=1000,gid=1000', '--mount', `type=bind,src=${mount},dst=/workspace`, '-e', 'HOME=/workspace', '-e', 'JAVA_TOOL_OPTIONS=-Duser.home=/workspace/.home', '-e', 'GRADLE_USER_HOME=/workspace/.gradle', '-e', 'MAVEN_USER_HOME=/workspace/.m2', '-e', 'CI=true', '-e', 'GIT_TERMINAL_PROMPT=0', '-w', '/workspace', process.env.EXECUTION_IMAGE || 'qa-repo-runner:public', 'sleep', 'infinity']);
              s.containerCreated = true;
            }
            s.status = 'ready'; s.message = 'Arbetsmiljön är redo';
          } catch (error) {
            try { await this.execute(['rm', '-f', name]); s.containerCreated = false; this.budget.release(s.id); }
            catch (cleanupError) { if (cleanupError.message.includes('No such container')) { s.containerCreated = false; this.budget.release(s.id); } else s.containerCreated = true; }
            s.status = 'blocked'; s.message = 'Arbetsmiljön kunde inte startas. Kontrollera worker och kapacitet.'; await this.save(s); throw error;
          }
        }
        if (seedFiles && s.seededTemplateKey !== input.templateKey) {
          await exec(['node', '-e', seedTemplateCommand], JSON.stringify(seedFiles));
          s.seededTemplateKey = input.templateKey;
        }
        s.expiresAt = Date.now() + this.leaseMs; await this.save(s); return this.view(s);
      }
      s = this.owned(input.id, input.owner);
      if (input.action === 'status') return this.view(s);
      if (['stop', 'delete'].includes(input.action)) { await this.close(s, input.action === 'delete' ? 'deleted' : 'stopped'); return this.view(s); }
      if (s.status !== 'ready') throw new Error('Sandbox is not running; reconnect before issuing commands');
      s.expiresAt = Date.now() + this.leaseMs;
      if (input.action === 'spawn') {
        if (typeof input.command !== 'string' || input.command.length > 16000 || !validId(input.processId)) throw new Error('Invalid command');
        const existing = s.processes.find(p => p.id === input.processId); if (existing) return existing;
        if (s.processes.filter(p => p.status === 'running' || p.status === 'starting').length >= 8) throw new Error('Process limit reached');
        const env = input.env || {};
        if (Object.keys(env).length > 30 || Object.entries(env).some(([key, value]) => !/^[A-Za-z_][\w]*$/.test(key) || typeof value !== 'string' || value.length > 4000)) throw new Error('Invalid environment');
        const process = { id: input.processId, status: 'starting', exitCode: null, stdout: '', stderr: '' }; s.processes.push(process); s.processes = s.processes.slice(-30); await this.save(s);
        try { await this.execute(['exec', '-d', name, 'node', '/opt/qa/process.cjs', input.processId, input.command, sandboxPath(input.workingDirectory || '/workspace'), JSON.stringify(env)]); }
        catch (error) { process.status = 'interrupted'; process.stderr = error.message; await this.save(s); throw error; }
        return process;
      }
      if (input.action === 'process' || input.action === 'kill') {
        if (!validId(input.processId)) throw new Error('Invalid process ID');
        const process = s.processes.find(p => p.id === input.processId); if (!process) throw new Error('Process not found');
        if (input.action === 'kill') await exec(['node', '-e', "const f=require('fs');const p=JSON.parse(f.readFileSync(process.argv[1]));if(p.status==='running'&&p.pid>1){try{process.kill(-p.pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e}}", `/tmp/qa-processes/${input.processId}.json`]);
        const result = await exec(['node', '-e', "const f=require('fs');const p=process.argv[1];console.log(f.existsSync(p)?f.readFileSync(p,'utf8'):'null')", `/tmp/qa-processes/${input.processId}.json`]);
        const state = JSON.parse(result); if (state) Object.assign(process, state); await this.save(s); return process;
      }
      const path = sandboxPath(input.path || '/workspace');
      if (input.action === 'read') {
        const data = await exec(['node', '-e', "const f=require('fs'),p=process.argv[1];if(!f.existsSync(p)){console.log('null')}else{if(f.statSync(p).size>24000000)throw Error('File exceeds 24 MB');console.log(JSON.stringify(f.readFileSync(p).toString('base64')))}", path]); await this.save(s); return { data: JSON.parse(data) };
      }
      if (input.action === 'write') {
        if (typeof input.data !== 'string' || input.data.length > 32000000) throw new Error('File exceeds 24 MB');
        await exec(['node', '-e', "const f=require('fs'),p=process.argv[1];f.mkdirSync(require('path').dirname(p),{recursive:true});f.writeFileSync(p,Buffer.from(f.readFileSync(0,'utf8'),'base64'))", path], input.data); await this.save(s); return { saved: true };
      }
      if (input.action === 'remove') { if (path === '/workspace') throw new Error('Cannot remove workspace root'); await exec(['node', '-e', "require('fs').rmSync(process.argv[1],JSON.parse(process.argv[2]))", path, JSON.stringify({ recursive: !!input.recursive, force: !!input.force })]); await this.save(s); return { removed: true }; }
      throw new Error('Unsupported sandbox action');
    });
  }
  async close(s, status) {
    s.message = 'Stoppar arbetsmiljön'; await this.save(s);
    await this.onClose?.(s.id);
    if (s.containerCreated) await this.execute(['stop', '-t', '3', `qa-sandbox-${s.id}`]);
    if (status !== 'stopped') {
      if (s.containerCreated) await this.execute(['rm', '-f', `qa-sandbox-${s.id}`]);
      await this.storage.remove(s.id); s.containerCreated = false;
    }
    s.status = status; s.message = status === 'stopped' ? 'Stoppad. Filerna behålls tills miljön löper ut.' : 'Miljön och arbetsfilerna är borttagna.';
    for (const p of s.processes) if (p.status !== 'completed') p.status = 'interrupted';
    this.budget.release(s.id); await this.save(s);
  }
  async tick() {
    for (const s of this.sessions.values()) await this.serial(s.id, async () => {
      if (['deleted', 'expired'].includes(s.status)) return;
      if (s.expiresAt < Date.now()) return this.close(s, 'expired');
      if (s.status !== 'ready') return;
      for (const p of s.processes.filter(p => ['running', 'starting'].includes(p.status))) {
        const data = await this.execute(['exec', `qa-sandbox-${s.id}`, 'node', '-e', "const f=require('fs');console.log(f.existsSync(process.argv[1])?f.readFileSync(process.argv[1],'utf8'):'null')", `/tmp/qa-processes/${p.id}.json`]);
        const state = JSON.parse(data); if (state) Object.assign(p, state);
      }
      await this.save(s);
    }).catch(error => console.error('Sandbox reconciliation:', error.message));
  }
}

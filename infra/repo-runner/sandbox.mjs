import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { validId } from '../execution/store.mjs';
import { SandboxStorage } from '../execution/storage.mjs';
import { SandboxTemplates, seedTemplateCommand } from './templates.mjs';
import { missionExecution } from '../../shared/mission-execution.mjs';
import { ExecutorAdmission, executionHash, sameExecution } from '../execution/admission.mjs';

export const sandboxDocker = (args, input, { timeoutMs = 30000, spawnProcess = spawn } = {}) => new Promise((resolve, reject) => {
  const child = spawnProcess('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout = (stdout + value).slice(-40000000); });
  child.stderr.on('data', value => { stderr = (stderr + value).slice(-4000); });
  child.on('error', reject); child.on('close', (code, signal) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `Container command did not succeed (${signal || code})`)));
  child.stdin.on('error', () => {}); child.stdin.end(input);
  const timeout = setTimeout(() => child.kill('SIGKILL'), Math.max(1, Math.min(timeoutMs, 180000))); child.on('close', () => clearTimeout(timeout));
});
export const sandboxPath = value => {
  if (typeof value !== 'string' || value.length > 1000 || value.includes('\0')) throw new Error('Invalid sandbox path');
  const path = value.startsWith('/') ? value : `/workspace/${value}`;
  if (path !== '/workspace' && !path.startsWith('/workspace/') && !path.startsWith('/tmp/')) throw new Error('Files must be inside /workspace or /tmp');
  if (path.split('/').includes('..')) throw new Error('Parent paths are not permitted');
  return path;
};
export class Sandboxes {
  constructor({ directory, events, budget, execute = sandboxDocker, leaseMs = 300000, storage = new SandboxStorage(`${directory}/disks`, 8), admission = new ExecutorAdmission(), now = Date.now, cleanupTimeoutMs = 30000 }) {
    Object.assign(this, { directory, events, budget, execute, leaseMs, storage, admission, now, cleanupTimeoutMs }); this.sessions = new Map(); this.locks = new Map(); this.cleanupLocks = new Map();
    this.templates = new SandboxTemplates(`${directory}/templates`);
  }
  async serial(id, operation) {
    const pending = (this.locks.get(id) || Promise.resolve()).catch(() => {}).then(operation); this.locks.set(id, pending);
    try { return await pending; } finally { if (this.locks.get(id) === pending) this.locks.delete(id); }
  }
  async save(session) {
    if (this.redact) session.processes = this.redact(session.id, session.processes);
    session.updatedAt = new Date().toISOString();
    const file = `${this.directory}/${session.id}.json`;
    await writeFile(file + '.tmp', JSON.stringify(session), { mode: 0o600 }); await rename(file + '.tmp', file);
    await this.events.publish(session.id, 'sandbox', 'progress', this.view(session));
  }
  view(s) {
    const visible = { ...s }; delete visible.owner; delete visible.execution; delete visible.spawnJournal; delete visible.ensureJournal; delete visible.cleanup; delete visible.cleanupRetry;
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
      if (s.execution) {
        // A worker restart must not revive an autonomous app or convert the
        // legacy stopped/file-retained state into a destruction receipt.
        if (!s.cleanup?.confirmed) this.budget.reserve(s.id, 1536);
        if (!await this.destroy(s, 'expired')) throw new Error('Autonomous sandbox cleanup remains unconfirmed; admission remains disabled');
        continue;
      }
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
      // Historical status and physical cleanup remain available after revocation.
      if (s && input.action === 'status') return this.view(s);
      if (s && ['stop', 'delete'].includes(input.action)) { await this.close(s, input.action === 'delete' ? 'deleted' : 'stopped'); return this.view(s); }
      if (s?.credentialBound && ['spawn', 'read', 'write', 'remove'].includes(input.action)) throw new Error('Credential-bound environments do not permit generic shell or file access');
      const execution = s ? sameExecution(s.execution, input.execution) : input.execution === undefined ? null : missionExecution(input.execution);
      if (execution && (typeof input.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,179}$/.test(input.operationId))) throw new Error('Stable sandbox operation ID required');
      if (execution && ['read', 'write', 'remove'].includes(input.action)) throw new Error('Autonomous file operations require a dedicated mission adapter');
      const authorize = async (suffix, kind, payload) => {
        if (execution) await this.admission.admit({ execution, resourceId: input.id, operationId: `${input.operationId}:${suffix}`, kind, payloadHash: executionHash(payload) });
      };
      const name = `qa-sandbox-${input.id}`;
      let commandIndex = 0;
      const execute = async (args, stdin) => {
        // This runs inside serial(), immediately before the physical command.
        await authorize(`command:${commandIndex++}`, 'sandbox.command', { args, stdin: stdin ?? null });
        return this.execute(args, stdin);
      };
      const exec = (args, stdin) => execute(['exec', '-i', name, ...args], stdin);
      if (input.action === 'ensure') {
        await authorize('ensure', 'sandbox.ensure', { id: input.id, templateKey: input.templateKey || null });
        const fingerprint = execution && executionHash({ templateKey: input.templateKey || null });
        if (execution && s?.ensureJournal?.[input.operationId]) {
          const previous = s.ensureJournal[input.operationId];
          if (previous.fingerprint !== fingerprint) throw new Error('Ensure operation ID already used for another template');
          if (previous.state !== 'completed') throw new Error('Previous environment start outcome is unknown; automatic replay is denied');
          // A receipt can be read after stop, but replay must not restart it.
          return this.view(s);
        }
        if (execution && Object.values(s?.ensureJournal || {}).some(entry => entry.state !== 'completed')) throw new Error('Unconfirmed environment start must be reconciled before another operation');
        if (execution && Object.keys(s?.ensureJournal || {}).length >= 64) throw new Error('Environment start journal limit reached');
        const seedFiles = input.templateKey ? await this.templates.get(input.templateKey) : null;
        if (s && ['deleted', 'expired'].includes(s.status)) throw new Error('Sandbox lease ended. Files are unavailable. Delete the Eve sandbox handle before creating a new environment.');
        if (s?.seededTemplateKey && input.templateKey && s.seededTemplateKey !== input.templateKey) throw new Error('Sandbox template changed; start a new environment');
        if (!s) {
          if ([...this.sessions.values()].filter(s => !['deleted', 'expired'].includes(s.status)).length >= 10) throw new Error('Sandbox storage capacity reached; close an unused environment');
          s = { id: input.id, workspaceId: input.workspaceId, owner: input.owner, ...(execution ? { execution } : {}), status: 'starting', createdAt: new Date().toISOString(), processes: [], message: 'Startar isolerad arbetsmiljö', expiresAt: Date.now() + this.leaseMs }; this.sessions.set(s.id, s); await this.save(s);
        }
        if (execution) {
          s.ensureJournal ||= {};
          s.ensureJournal[input.operationId] = { fingerprint, state: 'unknown' };
          await this.save(s);
        }
        if (s.status !== 'ready') {
          if (!this.budget.reserve(s.id, 1536)) { s.status = 'waiting'; s.message = 'Väntar på VPS-kapacitet. Försök igen när en pågående körning är klar.'; await this.save(s); throw new Error(s.message); }
          try {
            const mount = await this.storage.prepare(s.id);
            if (s.containerCreated) await execute(['start', name]);
            else {
              await execute(['run', '-d', '--runtime=runsc', '--name', name, '--label', 'qa.sandbox=true', '--init', '--network=qa-repo-net', '--dns=1.1.1.1', '--mount', 'type=bind,src=/opt/qa-repo-runner/resolv.conf,dst=/etc/resolv.conf,readonly', '--memory=1536m', '--memory-swap=1536m', '--cpus=1', '--pids-limit=256', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=1000:1000', '--tmpfs=/tmp:rw,exec,nosuid,nodev,size=268435456,uid=1000,gid=1000', '--mount', `type=bind,src=${mount},dst=/workspace`, '-e', 'HOME=/workspace', '-e', 'JAVA_TOOL_OPTIONS=-Duser.home=/workspace/.home', '-e', 'GRADLE_USER_HOME=/workspace/.gradle', '-e', 'MAVEN_USER_HOME=/workspace/.m2', '-e', 'CI=true', '-e', 'GIT_TERMINAL_PROMPT=0', '-w', '/workspace', process.env.EXECUTION_IMAGE || 'qa-repo-runner:public', 'sleep', 'infinity']);
              s.containerCreated = true;
            }
            s.status = 'ready'; s.message = 'Arbetsmiljön är redo';
          } catch (error) {
            if (execution) { await this.close(s, 'deleted').catch(() => {}); throw error; }
            try { await this.execute(['rm', '-f', name]); s.containerCreated = false; this.budget.release(s.id); }
            catch (cleanupError) { if (cleanupError.message.includes('No such container')) { s.containerCreated = false; this.budget.release(s.id); } else s.containerCreated = true; }
            s.status = 'blocked'; s.message = 'Arbetsmiljön kunde inte startas. Kontrollera worker och kapacitet.'; await this.save(s); throw error;
          }
        }
        if (seedFiles && (s.seededTemplateKey !== input.templateKey || s.seedLayoutVersion !== 1)) {
          await exec(['node', '-e', seedTemplateCommand], JSON.stringify(seedFiles));
          s.seededTemplateKey = input.templateKey;
          s.seedLayoutVersion = 1;
        }
        s.expiresAt = Date.now() + this.leaseMs;
        if (execution) s.ensureJournal[input.operationId].state = 'completed';
        await this.save(s); return this.view(s);
      }
      s = this.owned(input.id, input.owner);
      if (input.action === 'status') return this.view(s);
      if (['stop', 'delete'].includes(input.action)) { await this.close(s, input.action === 'delete' ? 'deleted' : 'stopped'); return this.view(s); }
      if (s.status !== 'ready') throw new Error('Sandbox is not running; reconnect before issuing commands');
      s.expiresAt = Date.now() + this.leaseMs;
      if (input.action === 'spawn') {
        if (typeof input.command !== 'string' || input.command.length > 16000 || !validId(input.processId)) throw new Error('Invalid command');
        const fingerprint = executionHash({ command: input.command, workingDirectory: input.workingDirectory || '/workspace', env: input.env || {} });
        const existing = s.processes.find(p => p.id === input.processId);
        if (existing) { if (existing.fingerprint !== fingerprint) throw new Error('Process ID already used for another or unknown command'); return existing; }
        s.spawnJournal ||= {};
        if (s.spawnJournal[input.processId]) throw new Error('Historical process receipt is unavailable; automatic replay is denied');
        if (Object.keys(s.spawnJournal).length >= 300) throw new Error('Process journal limit reached; start a new environment');
        if (s.processes.filter(p => p.status === 'running' || p.status === 'starting').length >= 8) throw new Error('Process limit reached');
        const env = input.env || {};
        if (execution && Object.keys(env).length) throw new Error('Autonomous environment values require worker-pull consent');
        if (Object.keys(env).length > 30 || Object.entries(env).some(([key, value]) => !/^[A-Za-z_][\w]*$/.test(key) || typeof value !== 'string' || value.length > 4000)) throw new Error('Invalid environment');
        const process = { id: input.processId, fingerprint, status: 'starting', exitCode: null, stdout: '', stderr: '' }; s.spawnJournal[input.processId] = fingerprint; s.processes.push(process); s.processes = s.processes.slice(-30); await this.save(s);
        try { await execute(['exec', '-d', name, 'node', '/opt/qa/process.cjs', input.processId, input.command, sandboxPath(input.workingDirectory || '/workspace'), JSON.stringify(env)]); }
        catch (error) { process.status = 'interrupted'; process.stderr = error.message; await this.save(s); throw error; }
        return process;
      }
      if (input.action === 'process' || input.action === 'kill') {
        if (!validId(input.processId)) throw new Error('Invalid process ID');
        const process = s.processes.find(p => p.id === input.processId); if (!process) throw new Error('Process not found');
        if (input.action === 'kill') await exec(['node', '-e', "const f=require('fs');const p=JSON.parse(f.readFileSync(process.argv[1]));if(p.status==='running'&&p.pid>1){try{process.kill(-p.pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e}}", `/tmp/qa-processes/${input.processId}.json`]);
        const result = await exec(['node', '-e', "const f=require('fs');const p=process.argv[1];console.log(f.existsSync(p)?f.readFileSync(p,'utf8'):'null')", `/tmp/qa-processes/${input.processId}.json`]);
        const state = JSON.parse(result); if (state) Object.assign(process, this.redact ? this.redact(s.id,state) : state); await this.save(s); return process;
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
    if (s.execution) {
      if (!await this.destroy(s, status === 'expired' ? 'expired' : 'deleted')) throw new Error('Autonomous sandbox cleanup remains unconfirmed');
      return s.cleanup;
    }
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
    if (s.credentialBound) this.forgetCredentials?.(s.id);
  }
  /** Autonomous terminal cleanup is physical destruction, not resumable manual
   * stop. Each bounded attempt is recorded before effects and survives restart. */
  async destroy(s, status = 'deleted') {
    if (!validId(s.id) || this.sessions.get(s.id) !== s || !['deleted', 'expired'].includes(status)) throw new Error('Unknown sandbox cleanup identity');
    const binding = executionHash(missionExecution(s.execution));
    if (s.cleanup && (s.cleanup.resourceId !== s.id || s.cleanup.executionHash !== binding)) throw new Error('Sandbox cleanup execution identity changed');
    if (s.cleanup?.confirmed) {
      if (!['deleted', 'expired'].includes(s.status) || s.containerCreated !== false) throw new Error('Inconsistent sandbox cleanup receipt');
      this.budget.release(s.id); return true;
    }
    if (this.cleanupLocks.has(s.id)) return this.cleanupLocks.get(s.id);
    const previous = s.cleanupRetry, count = previous?.attempts ?? 0, now = this.now();
    if (!Number.isSafeInteger(count) || count < 0 || previous && (!Number.isFinite(Date.parse(previous.attemptedAt)) || !Number.isFinite(Date.parse(previous.nextAttemptAt)))) throw new Error('Invalid sandbox cleanup retry history');
    if (count >= 3 || previous && now < Date.parse(previous.nextAttemptAt)) return false;
    const abort = new AbortController(); let timer;
    const work = Promise.resolve().then(async () => {
      s.cleanup = { resourceId: s.id, executionHash: binding, confirmed: false, observedAt: new Date(now).toISOString() };
      s.cleanupRetry = { attempts: count + 1, attemptedAt: new Date(now).toISOString(), nextAttemptAt: new Date(now + 30000).toISOString(), exhausted: count + 1 >= 3 };
      s.status = 'blocked'; s.message = 'Städning av den autonoma miljön är inte bekräftad.';
      await this.save(s); abort.signal.throwIfAborted();
      await this.onClose?.(s.id); abort.signal.throwIfAborted();
      const name = `qa-sandbox-${s.id}`;
      // Always remove the exact name: a crashed create may precede the saved
      // containerCreated flag. Only an exact missing-resource error is proof.
      try { await this.execute(['rm', '-f', name]); }
      catch (error) { if (!new RegExp(`No such container:\\s*${name}(?:\\s|$)`).test(error.message)) throw error; }
      abort.signal.throwIfAborted();
      await this.storage.remove(s.id); abort.signal.throwIfAborted();
      const confirmed = { ...s, containerCreated: false, status, message: 'Miljön och arbetsfilerna är borttagna.',
        processes: s.processes.map(p => p.status === 'completed' ? p : { ...p, status: 'interrupted' }),
        cleanup: { resourceId: s.id, executionHash: binding, confirmed: true, observedAt: new Date(this.now()).toISOString() } };
      await this.save(confirmed); abort.signal.throwIfAborted();
      Object.assign(s, confirmed); this.budget.release(s.id);
      if (s.credentialBound) this.forgetCredentials?.(s.id);
      return true;
    }).catch(() => false);
    const response = Promise.race([work, new Promise(resolve => { timer = setTimeout(() => { abort.abort(); resolve(false); }, this.cleanupTimeoutMs); })]);
    this.cleanupLocks.set(s.id, response);
    // A timeout does not permit a second physical removal while the first is
    // still in flight. Only its completion releases this in-process fence.
    void work.finally(() => { clearTimeout(timer); if (this.cleanupLocks.get(s.id) === response) this.cleanupLocks.delete(s.id); });
    return response;
  }
  async tick() {
    for (const s of this.sessions.values()) await this.serial(s.id, async () => {
      if (s.execution && s.cleanup && !s.cleanup.confirmed) {
        if (!s.cleanupRetry?.exhausted && this.now() >= Date.parse(s.cleanupRetry.nextAttemptAt)) await this.destroy(s, 'deleted');
        return;
      }
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

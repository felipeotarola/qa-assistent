import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inspectionCommand, executionPlan } from './preflight.mjs';

export const terminal = status => ['passed', 'failed', 'blocked', 'cancelled', 'review'].includes(status);
export function validate(input) {
  if (!input || !/^[a-f0-9-]{36}$/.test(input.id || '')) throw new Error('Invalid run ID');
  const url = new URL(input.url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/.test(url.pathname)) throw new Error('Use a public GitHub repository URL without credentials');
  const ref = input.ref || '';
  if (ref && (!/^[\w][\w./-]{0,150}$/.test(ref) || ref.includes('..') || ref.includes('@{'))) throw new Error('Invalid branch or tag');
  const script = input.script || 'auto';
  if (!/^[\w][\w:-]{0,79}$/.test(script)) throw new Error('Invalid npm script');
  const mode = input.mode === 'inspect' ? 'inspect' : input.mode === 'test' ? 'test' : null;
  if (!mode) throw new Error('Choose inspect or test');
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.length > 20 || input.args.some(arg => typeof arg !== 'string' || arg.length > 300 || arg.includes('\0')))) throw new Error('Invalid test arguments');
  if (input.directory && input.directory !== '.' && (!/^[\w][\w./-]{0,199}$/.test(input.directory) || input.directory.split('/').some(p => p === '..' || !p))) throw new Error('Invalid project directory');
  if (input.workspaceId && !/^[a-f0-9-]{36}$/.test(input.workspaceId)) throw new Error('Invalid workspace');
  return { ...(input.directory ? { directory: input.directory } : {}), ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), ...(input.args?.length ? { args: input.args } : {}), id: input.id, url: `https://github.com${url.pathname.replace(/\/$/, '').replace(/\.git$/, '')}`, ref, script, mode };
}
const command = (args, signal, onData) => new Promise((resolve, reject) => {
  const child = spawn('docker', args, { signal, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
    const text = data.toString().replaceAll(String.fromCharCode(27), '');
    output = (output + text).slice(-64000); onData?.(text);
  });
  child.on('error', reject);
  child.on('close', code => resolve({ code, output }));
});
export class Runner {
  constructor({ directory, timeoutMs = 600000, execute = command, fixture = null, onState = async () => {}, budget = null, storage = null }) {
    this.directory = directory; this.timeoutMs = timeoutMs;
    this.execute = execute; this.fixture = fixture; this.jobs = new Map(); this.controllers = new Map(); this.busy = false;
    this.onState = onState; this.writes = new Map(); this.stopping = false; this.budget = budget; this.lastWorkspace = null; this.storage = storage;
  }
  async save(job) {
    job.revision = (job.revision || 0) + 1;
    job.updatedAt = new Date().toISOString();
    job.telemetry ||= { workerId: 'vps-repository', heartbeatAt: job.updatedAt, phaseStartedAt: job.updatedAt };
    job.telemetry.heartbeatAt = job.updatedAt;
    const snapshot = structuredClone(job);
    const path = `${this.directory}/${job.id}.json`;
    const pending = (this.writes.get(job.id) || Promise.resolve()).catch(() => {}).then(async () => {
      await writeFile(`${path}.tmp`, JSON.stringify(snapshot), { mode: 0o600 }); await rename(`${path}.tmp`, path);
      await this.onState(snapshot);
    });
    this.writes.set(job.id, pending);
    try { await pending; } finally { if (this.writes.get(job.id) === pending) this.writes.delete(job.id); }
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      const job = JSON.parse(await readFile(`${this.directory}/${file}`, 'utf8'));
      this.jobs.set(job.id, job);
      if ((!terminal(job.status) && job.status !== 'queued') || job.telemetry?.failureKind === 'cleanup') {
        const removed = await this.execute(['rm', '-f', `qa-repo-${job.id}`], AbortSignal.timeout(30000));
        if (removed.code !== 0 && !removed.output.includes('No such container')) throw new Error('Interrupted container could not be removed; worker admission remains disabled');
        await this.storage?.remove(job.id);
        job.status = 'blocked'; job.message = 'Körningen avbröts när testtjänsten startades om. Starta en ny körning.';
        job.telemetry = { ...job.telemetry, failureKind: 'interrupted' };
        job.finishedAt = new Date().toISOString(); await this.save(job);
      }
    }
  }
  async submit(input) {
    const config = validate(input);
    const fingerprint = createHash('sha256').update(JSON.stringify(config)).digest('hex');
    const previous = this.jobs.get(config.id);
    if (previous) { if (previous.fingerprint !== fingerprint) throw new Error('Run ID already used'); return previous; }
    if ([...this.jobs.values()].filter(j => !terminal(j.status)).length >= 20) throw new Error('Test queue is full');
    const job = { ...config, fingerprint, status: 'queued', message: 'Väntar på testmiljö', logs: '', commit: null, package: null, testExitCode: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: null };
    this.jobs.set(job.id, job);
    try { await this.save(job); } catch (error) { this.jobs.delete(job.id); throw error; }
    void this.drain().catch(error => { console.error('Repository queue stopped:', error.message); }); return job;
  }
  async cancel(id) {
    const job = this.jobs.get(id); if (!job || terminal(job.status)) return job;
    if (this.controllers.has(id)) { job.telemetry.cancellationRequested = true; this.controllers.get(id).abort(); await this.save(job); }
    else { job.status = 'cancelled'; job.message = 'Avbruten'; job.finishedAt = new Date().toISOString(); await this.save(job); }
    return job;
  }
  async drain() {
    if (this.busy) return; this.busy = true;
    try {
      for (;;) {
        if (this.stopping) break;
        const queued = [...this.jobs.values()].filter(j => j.status === 'queued');
        // Rotate between workspaces rather than letting one submitter fill every slot.
        const job = queued.find(j => j.workspaceId !== this.lastWorkspace) || queued[0]; if (!job) break;
        for (const [index, entry] of [job, ...queued.filter(j => j !== job)].entries()) {
          entry.telemetry ||= {};
          if (entry.telemetry.queuePosition !== index + 1) { entry.telemetry.queuePosition = index + 1; await this.save(entry); }
        }
        if (this.budget && !this.budget.reserve(job.id, 1536)) break;
        this.lastWorkspace = job.workspaceId;
        try { await this.run(job); } finally { if (job.telemetry?.failureKind !== 'cleanup') this.budget?.release(job.id); }
      }
    } finally { this.busy = false; }
  }
  async run(job) {
    const abort = new AbortController(); this.controllers.set(job.id, abort);
    let timedOut = false, storageFailed = false;
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, this.timeoutMs);
    const name = `qa-repo-${job.id}`;
    job.telemetry = { workerId: 'vps-repository', heartbeatAt: new Date().toISOString(), startedAt: new Date().toISOString(), phaseStartedAt: new Date().toISOString(), operationKind: job.mode === 'inspect' ? 'inspect' : 'test' };
    let checkpointing = false;
    const checkpoint = setInterval(async () => {
      if (checkpointing) return;
      checkpointing = true;
      try { await this.save(job); } catch { storageFailed = true; abort.abort(); } finally { checkpointing = false; }
    }, 500);
    checkpoint.unref();
    const phase = async (status, message) => { job.status = status; job.message = message; job.telemetry.phaseStartedAt = new Date().toISOString(); await this.save(job); };
    const exec = async args => {
      abort.signal.throwIfAborted();
      const result = await this.execute(args, abort.signal, text => { job.logs = (job.logs + text).slice(-64000); job.updatedAt = new Date().toISOString(); });
      job.logs = (job.logs + `\n[runner] Exit code: ${result.code}\n`).slice(-64000);
      if (abort.signal.aborted) throw new Error('Stopped');
      return result;
    };
    let workingDirectory = '/workspace/repo';
    const inside = args => {
      job.logs = (job.logs + `\n$ ${args.map(arg => JSON.stringify(arg)).join(' ')}\n`).slice(-64000);
      return exec(['exec', '-w', workingDirectory, ...(job.plan?.runtime === 'node22' ? ['-e', 'PATH=/opt/node22/bin:/usr/local/bin:/usr/bin:/bin'] : []), name, ...args]);
    };
    let outcome = 'blocked', message = '';
    try {
      await phase('preparing', 'Hämtar repository och identifierar projektet');
      const workspaceMount = this.storage ? ['--mount', `type=bind,src=${await this.storage.prepare(job.id)},dst=/workspace`] : ['--tmpfs', '/workspace:rw,exec,nosuid,nodev,size=4294967296,uid=1000,gid=1000'];
      const launched = await exec(['run', '-d', '--runtime=runsc', '--name', name, '--label', 'qa.repository-run=true', '--init', '--network', 'qa-repo-net', '--dns', '1.1.1.1', '--dns', '8.8.8.8', '--mount', 'type=bind,src=/opt/qa-repo-runner/resolv.conf,dst=/etc/resolv.conf,readonly', '--memory', '1536m', '--memory-swap', '1536m', '--cpus', '1', '--pids-limit', '256', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000', ...workspaceMount, '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=268435456,uid=1000,gid=1000', '-e', 'HOME=/workspace/.home', '-e', 'PLAYWRIGHT_BROWSERS_PATH=/workspace/browsers', '-e', 'JAVA_TOOL_OPTIONS=-Duser.home=/workspace/.home', '-e', 'GRADLE_USER_HOME=/workspace/.gradle', '-e', 'MAVEN_USER_HOME=/workspace/.m2', '-e', 'CI=true', '-e', 'GIT_TERMINAL_PROMPT=0', process.env.EXECUTION_IMAGE || 'qa-repo-runner:public', 'sleep', 'infinity']);
      if (launched.code !== 0) { job.telemetry.failureKind = 'runtime'; throw new Error('Testmiljön kunde inte startas'); }
      if (this.fixture) await this.fixture(name, exec);
      else {
        const fetched = await exec(['exec', '-w', '/workspace', name, 'git', '-c', 'http.followRedirects=false', 'clone', '--depth=1', ...(job.ref ? ['--branch', job.ref] : []), '--', job.url, 'repo']);
        if (fetched.code !== 0) { job.telemetry.failureKind = 'checkout'; throw new Error('Repository kunde inte hämtas. Kontrollera att URL och branch är publika.'); }
      }
      const revision = await inside(['git', 'rev-parse', 'HEAD']);
      if (revision.code !== 0 || !/^[a-f0-9]{40}$/.test(revision.output.trim())) throw new Error('Kunde inte fastställa commit');
      job.commit = revision.output.trim();
      const metadata = await inside(['node', '-e', inspectionCommand]);
      job.telemetry.failureKind = 'configuration';
      if (metadata.code !== 0) throw new Error('Projektfilerna kunde inte läsas. Se körloggen.');
      const inventory = JSON.parse(metadata.output.trim());
      job.projects = inventory.projects || [];
      job.plan = executionPlan(inventory, job);
      job.package = job.plan.project.kind === 'node' ? job.plan.project : null;
      job.selectedScript = job.plan.selectedScript;
      job.telemetry.operationKind = job.plan.operationKind;
      workingDirectory = '/workspace/repo' + (job.plan.directory === '.' ? '' : '/' + job.plan.directory);
      if (job.mode === 'inspect') { outcome = 'review'; message = 'Projekt och körningsplan identifierade. Inga tester har körts.'; }
      else {
        job.telemetry.failureKind = 'dependencies';
        await phase('installing', 'Installerar beroenden enligt körningsplanen');
        for (const command of job.plan.install) {
          const installed = await inside(command);
          if (installed.code !== 0) throw new Error('Beroenden kunde inte installeras. Läs loggen; inga tester har körts.');
        }
        if (job.plan.runtime.startsWith('node')) {
          const browserInstall = await inside(['node', '-e', "const fs=require('fs'); if(fs.existsSync('node_modules/playwright/cli.js')) { const r=require('child_process').spawnSync(process.execPath,['node_modules/playwright/cli.js','install'],{stdio:'inherit'});process.exit(r.status ?? 1) }"]);
          if (browserInstall.code !== 0) throw new Error('Playwrights webbläsare kunde inte installeras. Se körloggen.');
        }
        await phase('running', 'Kör ' + job.selectedScript + ' i ' + job.plan.directory);
        job.telemetry.failureKind = 'command';
        const tested = await inside(['xvfb-run', '-a', ...job.plan.command]);
        job.testExitCode = tested.code;
        outcome = tested.code === 0 ? 'passed' : 'failed';
        message = 'Kommandot avslutades med exitkod ' + tested.code + '. Se loggen för verifierade resultat.';
        if (job.plan.operationKind === 'static-check') message += ' Statisk kontroll; funktionella tester har inte verifierats.';
      }
    } catch (error) {
      outcome = abort.signal.aborted ? timedOut ? 'blocked' : 'cancelled' : 'blocked';
      message = abort.signal.aborted ? timedOut ? 'Tidsgränsen nåddes. Körningen är blockerad, inte ett testresultat.' : 'Körningen avbröts.' : error.message;
      if (abort.signal.aborted) job.telemetry.failureKind = timedOut ? 'timeout' : 'interrupted';
      if (storageFailed) { outcome = 'blocked'; message = 'Körstatus kunde inte sparas. Körningen stoppades.'; job.telemetry.failureKind = 'runtime'; }
    } finally {
      clearTimeout(timer);
      clearInterval(checkpoint);
      await phase('cleaning', 'Städar testmiljön').catch(() => { storageFailed = true; });
      try {
        const removed = await this.execute(['rm', '-f', name], AbortSignal.timeout(30000));
        if (removed.code !== 0 && !removed.output.includes('No such container')) { outcome = 'blocked'; job.telemetry.failureKind = 'cleanup'; message = 'Testmiljön kunde inte städas. Kontakta administratören.'; } else await this.storage?.remove(job.id);
      } catch { outcome = 'blocked'; job.telemetry.failureKind = 'cleanup'; message = 'Testmiljön kunde inte städas. Administratören behöver kontrollera tjänsten.'; }
      if (['passed', 'review'].includes(outcome)) delete job.telemetry.failureKind;
      if (storageFailed && job.telemetry.failureKind !== 'cleanup') { outcome = 'blocked'; job.telemetry.failureKind = 'runtime'; message = 'Körstatus kunde inte sparas tillförlitligt. Se loggen och starta vid behov en ny körning.'; }
      job.status = outcome; job.message = message; job.finishedAt = new Date().toISOString();
      this.controllers.delete(job.id); await this.save(job);
    }
  }
}

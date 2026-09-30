import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const terminal = status => ['passed', 'failed', 'blocked', 'cancelled', 'review'].includes(status);
export function validate(input) {
  if (!input || !/^[a-f0-9-]{36}$/.test(input.id || '')) throw new Error('Invalid run ID');
  const url = new URL(input.url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/.test(url.pathname)) throw new Error('Use a public GitHub repository URL without credentials');
  const ref = input.ref || '';
  if (ref && (!/^[\w][\w./-]{0,150}$/.test(ref) || ref.includes('..') || ref.includes('@{'))) throw new Error('Invalid branch or tag');
  const script = input.script || 'test';
  if (!/^[\w][\w:-]{0,79}$/.test(script)) throw new Error('Invalid npm script');
  const mode = input.mode === 'inspect' ? 'inspect' : input.mode === 'test' ? 'test' : null;
  if (!mode) throw new Error('Choose inspect or test');
  return { id: input.id, url: `https://github.com${url.pathname.replace(/\/$/, '').replace(/\.git$/, '')}`, ref, script, mode };
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
  constructor({ directory, allowedRepos = [], timeoutMs = 600000, execute = command, fixture = null }) {
    this.directory = directory; this.allowedRepos = allowedRepos; this.timeoutMs = timeoutMs;
    this.execute = execute; this.fixture = fixture; this.jobs = new Map(); this.controllers = new Map(); this.busy = false;
  }
  async save(job) {
    job.updatedAt = new Date().toISOString();
    // All writes for a job are serialized by its worker, except stop requests which only abort it.
    const path = `${this.directory}/${job.id}.json`;
    await writeFile(`${path}.tmp`, JSON.stringify(job), { mode: 0o600 }); await rename(`${path}.tmp`, path);
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      const job = JSON.parse(await readFile(`${this.directory}/${file}`, 'utf8'));
      this.jobs.set(job.id, job);
      if (!terminal(job.status)) {
        await this.execute(['rm', '-f', `qa-repo-${job.id}`]).catch(() => {});
        job.status = 'blocked'; job.message = 'Körningen avbröts när testtjänsten startades om. Starta en ny körning.';
        job.finishedAt = new Date().toISOString(); await this.save(job);
      }
    }
  }
  async submit(input) {
    const config = validate(input);
    const fingerprint = createHash('sha256').update(JSON.stringify(config)).digest('hex');
    const previous = this.jobs.get(config.id);
    if (previous) { if (previous.fingerprint !== fingerprint) throw new Error('Run ID already used'); return previous; }
    if (!this.allowedRepos.includes(config.url)) throw new Error('Repository is not approved for this pilot. Ask the workspace administrator to allow it.');
    if ([...this.jobs.values()].filter(j => !terminal(j.status)).length >= 20) throw new Error('Test queue is full');
    const job = { ...config, fingerprint, status: 'queued', message: 'Väntar på testmiljö', logs: '', commit: null, package: null, testExitCode: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: null };
    this.jobs.set(job.id, job);
    try { await this.save(job); } catch (error) { this.jobs.delete(job.id); throw error; }
    void this.drain(); return job;
  }
  async cancel(id) {
    const job = this.jobs.get(id); if (!job || terminal(job.status)) return job;
    if (this.controllers.has(id)) this.controllers.get(id).abort();
    else { job.status = 'cancelled'; job.message = 'Avbruten'; job.finishedAt = new Date().toISOString(); await this.save(job); }
    return job;
  }
  async drain() {
    if (this.busy) return; this.busy = true;
    try {
      for (;;) {
        const job = [...this.jobs.values()].find(j => j.status === 'queued'); if (!job) break;
        await this.run(job);
      }
    } finally { this.busy = false; }
  }
  async run(job) {
    const abort = new AbortController(); this.controllers.set(job.id, abort);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, this.timeoutMs);
    const name = `qa-repo-${job.id}`;
    const phase = async (status, message) => { job.status = status; job.message = message; await this.save(job); };
    const exec = async args => {
      abort.signal.throwIfAborted();
      const result = await this.execute(args, abort.signal, text => { job.logs = (job.logs + text).slice(-64000); });
      job.logs = (job.logs + `\n[runner] Exit code: ${result.code}\n`).slice(-64000);
      if (abort.signal.aborted) throw new Error('Stopped');
      return result;
    };
    const inside = args => exec(['exec', '-w', '/workspace/repo', name, ...args]);
    let outcome = 'blocked', message = '';
    try {
      await phase('preparing', 'Hämtar repository och identifierar projektet');
      const launched = await exec(['run', '-d', '--name', name, '--label', 'qa.repository-run=true', '--init', '--network', 'qa-repo-net', '--memory', '3g', '--memory-swap', '3g', '--cpus', '1', '--pids-limit', '256', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000', '--tmpfs', '/workspace:rw,exec,nosuid,nodev,size=2147483648,uid=1000,gid=1000', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1073741824,uid=1000,gid=1000', '-e', 'HOME=/tmp', '-e', 'CI=true', '-e', 'GIT_TERMINAL_PROMPT=0', 'qa-repo-runner:node24', 'sleep', 'infinity']);
      if (launched.code !== 0) throw new Error('Testmiljön kunde inte startas');
      if (this.fixture) await this.fixture(name, exec);
      else {
        const fetched = await exec(['exec', '-w', '/workspace', name, 'git', '-c', 'http.followRedirects=false', 'clone', '--depth=1', ...(job.ref ? ['--branch', job.ref] : []), '--', job.url, 'repo']);
        if (fetched.code !== 0) throw new Error('Repository kunde inte hämtas. Kontrollera att URL och branch är publika.');
      }
      const revision = await inside(['git', 'rev-parse', 'HEAD']);
      if (revision.code !== 0 || !/^[a-f0-9]{40}$/.test(revision.output.trim())) throw new Error('Kunde inte fastställa commit');
      job.commit = revision.output.trim();
      const metadata = await inside(['node', '-e', "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));console.log(JSON.stringify({name:p.name,scripts:p.scripts||{},packageManager:p.packageManager||null,lock:fs.existsSync('package-lock.json'),pnpmLock:fs.existsSync('pnpm-lock.yaml')}))"]);
      if (metadata.code !== 0) throw new Error('Piloten stöder Node-projekt med package.json i repots rot.');
      job.package = JSON.parse(metadata.output.trim());
      if (job.mode === 'inspect') { outcome = 'review'; message = 'Repository analyserat. Välj ett testscript innan du kör tester.'; }
      else {
        const pnpm = job.package.packageManager === 'pnpm@10.33.4';
        if (pnpm ? !job.package.pnpmLock : !job.package.lock || (job.package.packageManager && !job.package.packageManager.startsWith('npm@'))) throw new Error('Piloten behöver npm + package-lock.json eller pnpm@10.33.4 + pnpm-lock.yaml.');
        const manager = pnpm ? 'pnpm' : 'npm';
        if (!Object.hasOwn(job.package.scripts, job.script)) throw new Error(`Testscriptet ${job.script} saknas. Välj ett befintligt script.`);
        await phase('installing', 'Installerar låsta beroenden utan installationsscript');
        const installed = await inside(pnpm ? ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'] : ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
        if (installed.code !== 0) throw new Error('Beroenden kunde inte installeras. Läs loggen; inga tester har körts.');
        await phase('running', `Kör ${manager} run ${job.script}`);
        const tested = await inside(pnpm ? ['pnpm', '--config.enable-pre-post-scripts=false', 'run', job.script] : ['npm', '--ignore-scripts', 'run', job.script]);
        job.testExitCode = tested.code;
        outcome = tested.code === 0 ? 'passed' : 'failed';
        message = tested.code === 0 ? 'Testkommandot slutfördes med exitkod 0. Se loggen för vilka tester som kördes.' : `Testkommandot misslyckades (exitkod ${tested.code}). Se loggen för resultat.`;
      }
    } catch (error) {
      outcome = abort.signal.aborted ? timedOut ? 'blocked' : 'cancelled' : 'blocked';
      message = abort.signal.aborted ? timedOut ? 'Tidsgränsen nåddes. Körningen är blockerad, inte ett testresultat.' : 'Körningen avbröts.' : error.message;
    } finally {
      clearTimeout(timer);
      await phase('cleaning', 'Städar testmiljön');
      try {
        const removed = await this.execute(['rm', '-f', name], AbortSignal.timeout(30000));
        if (removed.code !== 0 && !removed.output.includes('No such container')) { outcome = 'blocked'; message = 'Testmiljön kunde inte städas. Kontakta administratören.'; }
      } catch { outcome = 'blocked'; message = 'Testmiljön kunde inte städas. Administratören behöver kontrollera tjänsten.'; }
      job.status = outcome; job.message = message; job.finishedAt = new Date().toISOString();
      this.controllers.delete(job.id); await this.save(job);
    }
  }
}

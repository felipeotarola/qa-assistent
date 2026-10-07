import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, statfsSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ownedScopes = new Set();
const scopeName = /^syna-codex-[a-f0-9-]{36}$/;
function populated(directory) {
  const value = readFileSync(`${directory}/cgroup.events`, 'utf8').match(/^populated ([01])$/m)?.[1];
  if (value === undefined) throw new Error('Codex process isolation state is unavailable');
  return value === '1';
}
function isolationRoot() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Codex requires root-owned Linux cgroup v2 isolation');
  const path = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(line => line.startsWith('0::'))?.slice(3);
  if (!path?.startsWith('/') || path.split('/').includes('..')) throw new Error('Codex cgroup v2 parent is unavailable');
  const root = resolve('/sys/fs/cgroup', `.${path}`), child = relative('/sys/fs/cgroup', root);
  if (child === '..' || child.startsWith(`..${sep}`) || realpathSync(root) !== root || statfsSync(root).type !== 0x63677270) throw new Error('Codex requires its own cgroup v2 parent');
  // A crashed worker must not forget a surviving model process and admit more.
  for (const name of readdirSync(root).filter(name => scopeName.test(name))) {
    const directory = `${root}/${name}`;
    if (!ownedScopes.has(directory) && populated(directory)) throw new Error('An earlier Codex process still requires confirmed cleanup');
  }
  return root;
}

/** The unprivileged app-server cannot move out of this root-owned cgroup.
 * Descendants remain bound even if they fork, reparent or create a new session.
 * The parent remains the worker's service cgroup, preserving systemd cleanup. */
export function createCodexProcessScope() {
  const id = randomUUID(), directory = `${isolationRoot()}/syna-codex-${id}`;
  mkdirSync(directory, { mode: 0o700 });
  try {
    accessSync(`${directory}/cgroup.kill`, constants.W_OK);
    accessSync(`${directory}/cgroup.procs`, constants.W_OK);
    if (populated(directory)) throw new Error('New Codex process scope is not empty');
  } catch (error) { rmdirSync(directory); throw error; }
  ownedScopes.add(directory);
  return {
    id, mechanism: 'cgroup-v2',
    attach(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Codex launcher did not start');
      writeFileSync(`${directory}/cgroup.procs`, String(pid));
      if (!readFileSync(`${directory}/cgroup.procs`, 'utf8').trim().split('\n').includes(String(pid))) throw new Error('Codex launcher is outside its process scope');
    },
    empty: () => !populated(directory),
    kill: () => writeFileSync(`${directory}/cgroup.kill`, '1'),
    dispose() {
      if (populated(directory)) throw new Error('Codex process scope is still populated');
      rmdirSync(directory); ownedScopes.delete(directory);
    },
  };
}

/** Readiness probes only create/remove an empty private scope; no model starts. */
export function codexProcessIsolationCapability() {
  try { const scope = createCodexProcessScope(); scope.dispose(); return { available: true, mechanism: 'cgroup-v2' }; }
  catch { return { available: false, mechanism: 'cgroup-v2', reason: 'Linux cgroup v2 isolation is unavailable or previous cleanup is unconfirmed' }; }
}

// The control process has no repository checkout, shell tools or execution
// environment. Only the parent's scoped dynamic tools can execute repo code.
export const threadOptions = {
  cwd: '/var/lib/qa-codex/control', environments: [], ephemeral: true,
  approvalPolicy: 'never', sandbox: 'read-only',
  config: {
    'features.shell_tool': false, 'features.unified_exec': false,
    'features.apps': false, 'features.browser_use': false,
    'features.computer_use': false, 'features.multi_agent': false,
    'web_search': 'disabled',
  },
};

export class CodexClient {
  constructor({ onRequest, onEvent, onExit = () => {}, binary = '/opt/qa-codex/codex', spawnProcess = spawn, createProcessScope = createCodexProcessScope, closeGraceMs = 3000, closeForceMs = 1000 }) {
    this.pending = new Map(); this.seq = 0; this.closed = false;
    this.closeGraceMs = closeGraceMs; this.closeForceMs = closeForceMs;
    this.scope = createProcessScope(); // Fails before creating a control process.
    try { this.child = spawnProcess('/bin/sh', ['-c', 'IFS= read -r ready <&3 && [ "$ready" = ready ] || exit 125; exec /usr/sbin/runuser -u qa-codex -- "$@"', 'syna-codex-launch', binary, 'app-server', '--stdio'], {
      // Never inherit runner/internal/model keys into Codex or its subprocesses.
      env: { PATH: '/usr/bin:/bin', HOME: '/var/lib/qa-codex', CODEX_HOME: '/var/lib/qa-codex/.codex' },
      detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    }); } catch (error) { this.scope.dispose(); throw error; }
    this.child.stderr.on('data', () => {}); // May contain account details; do not publish.
    this.child.stdin.on('error', () => {});
    this.child.on('error', () => { if (!this.child.pid) this.exited = true; this.fail(new Error('Codex process could not start')); });
    this.child.on('exit', () => { this.exited = true; const unexpected = !this.closed; this.fail(new Error('Codex process stopped')); if (unexpected) onExit(); });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.method && msg.id !== undefined) {
        Promise.resolve().then(() => onRequest(msg)).then(result => this.send({ id: msg.id, result }),
          () => this.send({ id: msg.id, error: { code: -32601, message: 'Request not permitted by worker' } }));
      } else if (msg.method) onEvent(msg);
      else {
        const p = this.pending.get(msg.id); if (!p) return;
        this.pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`Codex request failed (${msg.error.code})`)); else p.resolve(msg.result);
      }
    });
    // No provider or runuser process exists before physical membership is set.
    // FD3 is separate from JSON-RPC stdin and never receives credentials.
    const gate = this.child.stdio?.[3];
    gate?.on('error', () => {});
    try {
      if (!gate) throw new Error('Codex launch gate is unavailable');
      this.scope.attach(this.child.pid);
      gate.end('ready\n');
    } catch (error) {
      this.launchError = error;
      gate?.end();
      this.child.kill('SIGKILL');
    }
  }
  send(message) { if (!this.closed) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  request(method, params) {
    if (this.closed) return Promise.reject(new Error('Codex process stopped'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex request timed out')); }, 30000);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  fail(error) {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.fail(new Error('Codex session closed')); this.lines.close();
    this.closePromise = (async () => {
      const stopped = () => (this.exited || !this.child.pid) && this.scope.empty();
      const wait = async milliseconds => {
        const deadline = Date.now() + milliseconds;
        do { if (stopped()) return true; await delay(10); } while (Date.now() < deadline);
        return stopped();
      };
      this.child.stdio?.[3]?.end(); this.child.stdin.end();
      if (!this.exited) this.child.kill('SIGTERM');
      if (!await wait(this.closeGraceMs)) {
        this.scope.kill(); // Atomic recursive kill, including setsid descendants.
        if (!this.exited) this.child.kill('SIGKILL');
        if (!await wait(this.closeForceMs)) throw new Error('Codex process scope stop is unconfirmed');
      }
      this.scope.dispose();
      this.stopReceipt = { mechanism: this.scope.mechanism, scopeId: this.scope.id, empty: true, observedAt: new Date().toISOString() };
      return this.stopReceipt;
    })();
    return this.closePromise;
  }
  async initialize() {
    if (this.launchError) throw this.launchError;
    await this.request('initialize', { clientInfo: { name: 'qaa_repo_worker', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
    const { account } = await this.request('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt') throw new Error('Codex subscription login required on VPS');
  }
}

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

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
  constructor({ onRequest, onEvent, onExit = () => {}, binary = '/opt/qa-codex/codex' }) {
    this.pending = new Map(); this.seq = 0; this.closed = false;
    this.child = spawn('/usr/sbin/runuser', ['-u', 'qa-codex', '--', binary, 'app-server', '--stdio'], {
      // Never inherit runner/internal/model keys into Codex or its subprocesses.
      env: { PATH: '/usr/bin:/bin', HOME: '/var/lib/qa-codex', CODEX_HOME: '/var/lib/qa-codex/.codex' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', () => {}); // May contain account details; do not publish.
    this.child.stdin.on('error', () => {});
    this.child.on('error', () => this.fail(new Error('Codex process could not start')));
    this.child.on('exit', () => { const unexpected = !this.closed; this.fail(new Error('Codex process stopped')); if (unexpected) onExit(); });
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
  close() { this.fail(new Error('Codex session closed')); this.lines.close(); this.child.stdin.end(); this.child.kill('SIGTERM'); }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'qaa_repo_worker', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
    const { account } = await this.request('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt') throw new Error('Codex subscription login required on VPS');
  }
}

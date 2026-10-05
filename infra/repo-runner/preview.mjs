import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { allowedOrigins } from '../execution/http.mjs';
const run = promisify(execFile);
const exec = async (command, args) => (await run(command, args, { timeout: 30000, maxBuffer: 1000000 })).stdout.trim();
const ip = value => /^172\.30\.0\.\d{1,3}$/.test(value);

/** One isolated preview slot, within the fixed 3 GiB browser reservation.
 * The public browser pool must first be limited to 2 GiB. No container socket,
 * host mount or gateway credential is accessible to repository code.
 */
export class Previews {
  constructor({ sandboxes, base, execute = exec }) { Object.assign(this, { sandboxes, base, execute }); this.active = null; }
  async init() {
    if (!this.base) return;
    await this.execute('iptables', ['-N', 'QA_PREVIEW']).catch(() => {});
    await this.execute('iptables', ['-F', 'QA_PREVIEW']);
    try { await this.execute('iptables', ['-C', 'DOCKER-USER', '-j', 'QA_PREVIEW']); }
    catch { await this.execute('iptables', ['-I', 'DOCKER-USER', '1', '-j', 'QA_PREVIEW']); }
    // Preview sessions are deliberately interrupted, never replayed after restart.
    const names = await this.execute('docker', ['ps', '-aq', '--filter', 'label=qa.preview=true']);
    for (const name of names.split('\n').filter(Boolean)) await this.execute('docker', ['rm', '-f', name]);
  }
  async open(sandbox, port) {
    if (!this.base) throw new Error('App preview is not configured on this worker');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose an app port from 1024 to 65535');
    if (sandbox.status !== 'ready') throw new Error('Start the app in its sandbox before opening a preview');
    if (this.active) {
      if (this.active.id === sandbox.id && this.active.port === port && this.active.session) return this.active.session;
      throw new Error('Preview browser capacity reached. Close the current preview before opening another.');
    }
    const current = { id: sandbox.id, port, name: `qa-preview-${sandbox.id}`, key: randomBytes(32).toString('hex'), expiresAt: Date.now() + 1800000 };
    this.active = current;
    try {
      const publicMemory = Number(await this.execute('docker', ['inspect', '-f', '{{.HostConfig.Memory}}', 'qa-browser']));
      if (!publicMemory || publicMemory > 2147483648) throw new Error('Preview requires the public browser pool to have a verified 2 GiB memory limit');
      if (await this.execute('docker', ['network', 'inspect', '-f', '{{.EnableIPv6}}', 'qa-repo-net']) !== 'false') throw new Error('Preview network must have IPv6 disabled');
      if (await this.execute('sysctl', ['-n', 'net.bridge.bridge-nf-call-iptables']) !== '1') throw new Error('Preview requires bridge firewall filtering');
      const target = await this.execute('docker', ['inspect', '-f', '{{(index .NetworkSettings.Networks "qa-repo-net").IPAddress}}', `qa-sandbox-${sandbox.id}`]);
      if (!ip(target)) throw new Error('Sandbox is not on the assigned worker network');
      current.origin = `http://${target}:${port}`;
      await this.execute('docker', ['run', '-d', '--name', current.name, '--label', 'qa.preview=true', '--init', '--network', 'qa-repo-net', '--memory', '1g', '--memory-swap', '1g', '--cpus', '1', '--pids-limit', '256', '--shm-size', '256m', '--security-opt', 'seccomp=/opt/qa-browser/seccomp.json', '--cap-drop', 'ALL', '--cap-add', 'SYS_CHROOT', '-e', `BROWSER_SERVICE_KEY=${current.key}`, '-e', `BROWSER_PUBLIC_URL=${this.base}/preview/${sandbox.id}`, '-e', `BROWSER_PREVIEW_ORIGIN=${current.origin}`, '-e', `EXECUTION_ORIGINS=${allowedOrigins().join(',')}`, '-e', 'BROWSER_MAX_SESSIONS=1', process.env.PREVIEW_BROWSER_IMAGE || 'qa-browser:execution']);
      current.host = await this.execute('docker', ['inspect', '-f', '{{(index .NetworkSettings.Networks "qa-repo-net").IPAddress}}', current.name]);
      if (!ip(current.host) || current.host === target) throw new Error('Invalid preview worker network identity');
      current.rule = ['-s', `${current.host}/32`, '-d', `${target}/32`, '-p', 'tcp', '--dport', String(port), '-j', 'ACCEPT'];
      await this.execute('iptables', ['-A', 'QA_PREVIEW', ...current.rule]);
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try { if ((await this.request(current, '/health', 'GET')).ready) { ready = true; break; } } catch { /* Starting. */ }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (!ready) throw new Error('Preview browser did not become ready');
      const session = await this.request(current, '/sessions', 'POST');
      current.session = { ...session, previewUrl: current.origin, sandboxId: sandbox.id };
      return current.session;
    } catch (error) {
      await this.close(sandbox.id);
      // execFile messages can contain container environment arguments. Never
      // forward them to the model, API client or persisted execution log.
      // eslint-disable-next-line preserve-caught-error -- The cause contains the private container key in argv.
      if (error.cmd) throw new Error('Preview infrastructure failed. Check worker runtime, networking and capacity.');
      throw error;
    }
  }
  async request(current, path, method) {
    const response = await fetch(`http://${current.host}:8080${path}`, { method, headers: { authorization: `Bearer ${current.key}` }, signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error(`Preview browser request failed (${response.status})`);
    return response.json();
  }
  async close(id) {
    const current = this.active; if (!current || current.id !== id) return;
    // Revoke network access before removing the container. Failed cleanup keeps
    // the slot reserved and is retried; it never becomes an untracked browser.
    current.closing = true;
    await this.execute('iptables', ['-F', 'QA_PREVIEW']);
    try { await this.execute('docker', ['rm', '-f', current.name]); }
    catch (error) { if (!String(error.stderr || error.message).includes('No such container')) throw error; }
    this.active = null;
  }
  async tick() {
    const current = this.active; if (!current) return;
    const parent = this.sandboxes.sessions.get(current.id);
    if (current.closing || current.expiresAt <= Date.now() || !parent || parent.status !== 'ready' || parent.expiresAt <= Date.now()) await this.close(current.id);
  }
  match(path) {
    const match = path.match(/^\/preview\/([a-f0-9-]{36})(\/.*)$/);
    const current = this.active;
    if (!match || !current || current.id !== match[1] || current.closing || current.expiresAt <= Date.now()) return null;
    return { current, path: match[2] };
  }
  // Browser credentials are validated by the isolated worker. API requests still
  // require the service bearer at the outer gateway; only viewer/CDP are public.
  proxy(req, res, target) {
    const upstream = http.request({ host: target.current.host, port: 8080, method: req.method, path: target.path, headers: { ...req.headers, authorization: `Bearer ${target.current.key}` } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
  }
  upgrade(req, socket, head) {
    const target = this.match(req.url);
    if (!target || !/^\/(cdp|view)\/[a-f0-9-]{36}\?token=[a-f0-9]{64}$/.test(target.path)) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    const upstream = http.request({ host: target.current.host, port: 8080, path: target.path, headers: req.headers });
    upstream.on('upgrade', (response, remote, remoteHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (remoteHead.length) socket.write(remoteHead); if (head.length) remote.write(head);
      remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
      socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy()); socket.pipe(remote).pipe(socket);
    });
    upstream.on('response', response => { socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\n\r\n`); response.resume(); });
    upstream.on('error', () => socket.destroy()); upstream.end();
  }
}

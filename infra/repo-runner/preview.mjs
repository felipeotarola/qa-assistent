import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { allowedOrigins } from '../execution/http.mjs';
import { ExecutorAdmission, executionHash, sameExecution } from '../execution/admission.mjs';
import { missionExecution } from '../../shared/mission-execution.mjs';
import { previewHandoff, previewHandoffHash, matchPreviewHandoffReceipt } from '../../shared/preview-handoff.mjs';
import { environmentPlanHash } from '../../shared/mission-environment.mjs';
import { parseBrowserPolicy, browserPolicyDigest } from '../browser/policy.mjs';
const run = promisify(execFile);
const exec = async (command, args) => (await run(command, args, { timeout: 30000, maxBuffer: 1000000 })).stdout.trim();
const ip = value => /^172\.30\.0\.\d{1,3}$/.test(value) && Number(value.split('.').at(-1)) > 1 && Number(value.split('.').at(-1)) < 255;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);

/** One isolated preview slot, within the fixed 3 GiB browser reservation.
 * The public browser pool must first be limited to 2 GiB. No container socket,
 * host mount or gateway credential is accessible to repository code.
 */
export class Previews {
  constructor({ sandboxes, base, execute = exec, admission = new ExecutorAdmission(), environmentJob = () => null, fetch: request = globalThis.fetch }) {
    Object.assign(this, { sandboxes, base, execute, admission, environmentJob, fetch: request }); this.active = null; this.closed = new Map(); this.pending = Promise.resolve();
  }
  serial(operation) { const result = this.pending.catch(() => {}).then(operation); this.pending = result; return result; }
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
  environment(sandbox, input, historical = false) {
    if (!sandbox.execution || !input || Object.keys(input).some(key => !['execution', 'policy', 'expectedEnvironment'].includes(key))) throw new Error('Autonomous preview requires its exact execution and environment');
    const execution = missionExecution(input.execution), expected = input.expectedEnvironment;
    if (!expected || Object.keys(expected).length !== 3 || !uuid(expected.jobId) || !uuid(expected.processId) || !/^[a-f0-9]{64}$/.test(expected.planHash || '')) throw new Error('Invalid expected preview environment');
    const job = this.environmentJob(expected.jobId);
    if (!job || job.jobId !== expected.jobId || job.id !== sandbox.id || job.owner !== sandbox.owner || job.workspaceId !== sandbox.workspaceId
      || !historical && (job.status !== 'completed' || job.cleanup !== 'retained' || job.executorStopped !== true) || job.environmentExecution?.phase !== 'apply'
      || job.environment?.processId !== expected.processId || !job.environment.executionProfile || environmentPlanHash(job.environment) !== expected.planHash
      || job.environmentExecution.planHash !== expected.planHash || !(job.environment.httpStatus >= 200 && job.environment.httpStatus < 400)) throw new Error('Preview requires the exact retained, ready application');
    const original = sameExecution(sandbox.execution, job.execution);
    if (['runtime', 'missionId', 'mandateRevision', 'planRevision'].some(key => original[key] !== execution[key]) || execution.attemptId === original.attemptId
      || !historical && (sandbox.status !== 'ready' || sandbox.expiresAt <= Date.now() || Date.parse(execution.deadlineAt) <= Date.now() || Date.parse(original.deadlineAt) <= Date.now()
      || !sandbox.processes?.some(process => process.id === expected.processId && process.status === 'running'))) throw new Error('Preview environment is no longer current');
    return { execution, expectedEnvironment: { ...expected }, port: job.environment.port, deadlineAt: Math.min(Date.parse(original.deadlineAt), Date.parse(execution.deadlineAt)) };
  }
  /** Read-only address discovery. The route must first resolve sandbox ownership.
   * No network rule, container, browser session or heartbeat is created here. */
  async target(sandbox, input) {
    const verified = this.environment(sandbox, input);
    const target = await this.execute('docker', ['inspect', '-f', '{{(index .NetworkSettings.Networks "qa-repo-net").IPAddress}}', `qa-sandbox-${sandbox.id}`]);
    this.environment(sandbox, input);
    if (!ip(target)) throw new Error('Sandbox is not on the assigned worker network');
    return { origin: `http://${target}:${verified.port}`, envJobId: verified.expectedEnvironment.jobId, planHash: verified.expectedEnvironment.planHash };
  }
  historicalRequest(sandbox, port, input) {
    const binding = this.environment(sandbox, input, true);
    const deadline = Date.parse(input.policy?.deadlineAt);
    const policy = parseBrowserPolicy(input.policy, Math.min(Date.now(), deadline - 1));
    if (!policy || binding.port !== port || Date.parse(policy.deadlineAt) > binding.deadlineAt) throw new Error('Invalid historical preview policy');
    return executionHash({ sandboxId: sandbox.id, port, execution: binding.execution, policy, expectedEnvironment: binding.expectedEnvironment });
  }
  status(sandbox, port, input) {
    return this.serial(async () => {
      const requestHash = this.historicalRequest(sandbox, port, input);
      if (this.active?.id === sandbox.id) {
        if (this.active.requestHash !== requestHash) throw new Error('Preview execution or policy changed on status');
        const current = this.active;
        let handoff;
        if (current.authorization?.receipt && !current.closing) {
          // A cache alone cannot recover a lost handoff acknowledgement.
          // Historical cleanup still works if the current authorization expired.
          try {
            this.liveAuthorization(current, sandbox);
            const physical = await this.readSession(current);
            this.liveAuthorization(current, sandbox);
            if (physical.controlEpoch === current.authorization.receipt.controlEpoch) handoff = current.authorization.receipt;
          } catch { /* Unknown physical identity is not an authority receipt. */ }
        }
        return this.active.session && !this.active.closing ? { session: this.active.session, absent: false, cleanupConfirmed: false, ...(handoff ? { handoff } : {}) }
          : { absent: false, cleanupConfirmed: false, closing: !!this.active.closing };
      }
      const closed = this.closed.get(sandbox.id);
      if (closed && closed.requestHash !== requestHash) throw new Error('Preview execution changed on cleanup receipt');
      // In-memory absence alone is not evidence after restart or lost Docker
      // replies. Both the owned container and the preview network grant must be
      // absent. An unrelated live preview conservatively prevents this proof.
      try { await this.execute('docker', ['inspect', `qa-preview-${sandbox.id}`]); return { absent: false, cleanupConfirmed: false }; }
      catch (error) { if (!/No such (?:object|container)/i.test(String(error.stderr || error.message))) return { absent: false, cleanupConfirmed: false }; }
      const rules = await this.execute('iptables', ['-S', 'QA_PREVIEW']);
      if (rules.split('\n').some(line => line.startsWith('-A '))) return { absent: false, cleanupConfirmed: false };
      return { absent: true, cleanupConfirmed: true, cleanup: { sandboxId: sandbox.id, confirmed: true, observedAt: new Date().toISOString() } };
    });
  }
  closeBound(sandbox, port, input) {
    const requestHash = this.historicalRequest(sandbox, port, input);
    if (this.active?.id === sandbox.id && this.active.requestHash !== requestHash) return Promise.reject(new Error('Preview execution changed on close'));
    if (this.active?.id === sandbox.id) this.active.closing = true;
    return this.serial(async () => {
      this.historicalRequest(sandbox, port, input);
      if (this.active?.id === sandbox.id) {
        if (this.active.requestHash !== requestHash) throw new Error('Preview execution changed while closing');
        return this.closeInside(sandbox.id);
      }
      const closed = this.closed.get(sandbox.id);
      if (closed?.requestHash === requestHash) return closed.receipt;
      // A restarted worker cleans its labelled previews before serving HTTP.
      // Without a matching in-memory identity, status must prove that cleanup;
      // a new close must never infer ownership from a caller-supplied URL.
      return { sandboxId: sandbox.id, confirmed: false, observedAt: new Date().toISOString() };
    });
  }
  open(sandbox, port, input) { return this.serial(() => this.openInside(sandbox, port, input)); }
  liveAuthorization(current, sandbox) {
    if (this.active !== current || current.closing || current.expiresAt <= Date.now() || !sandbox || !current.authorization) throw new Error('Preview no longer owns authorization');
    const creation = { execution: current.execution, policy: current.policy, expectedEnvironment: current.expectedEnvironment };
    if (this.historicalRequest(sandbox, current.port, creation) !== current.requestHash) throw new Error('Preview creation changed');
    this.environment(sandbox, { ...creation, execution: current.authorization.execution });
    if (Date.parse(current.policy.deadlineAt) <= Date.now()) throw new Error('Preview policy expired');
  }
  async readSession(current) {
    const physical = await this.request(current, `/sessions/${current.sessionId}`, 'GET');
    if (physical.id !== current.sessionId || physical.status !== 'ready' || physical.control !== 'agent'
      || !Number.isSafeInteger(physical.controlEpoch) || physical.controlEpoch < 1 || physical.policyVersion !== 1
      || physical.policyDigest !== browserPolicyDigest(current.policy) || physical.expiresAt !== current.session.expiresAt
      || Date.parse(physical.expiresAt) <= Date.now()) throw new Error('Preview physical return is not confirmed');
    return physical;
  }
  /** No creation effects. The route already holds the sandbox lock. */
  handoff(sandbox, raw) {
    return this.serial(async () => {
      const input = previewHandoff(raw), requestHash = previewHandoffHash(input), current = this.active;
      if (!current || input.sandboxId !== sandbox.id || current.id !== sandbox.id || input.sessionId !== current.sessionId
        || input.creationRequestHash !== current.requestHash || input.port !== current.port
        || executionHash(input.policy) !== executionHash(current.policy)
        || executionHash(input.expectedEnvironment) !== executionHash(current.expectedEnvironment)) throw new Error('Preview handoff changed its creation');
      const previous = current.authorization;
      const replay = previous?.receipt?.requestHash === requestHash;
      this.liveAuthorization(current, sandbox);
      sameExecution(replay ? previous.execution : input.previousExecution, previous.execution);
      if (replay) sameExecution(input.execution, previous.execution);
      this.environment(sandbox, { execution: input.execution, policy: current.policy, expectedEnvironment: current.expectedEnvironment });
      await this.admission.admit({ execution: input.execution, resourceId: input.execution.dispatchId,
        operationId: `preview:handoff:${input.handoffId}`, kind: 'environment.preview', payloadHash: requestHash });
      this.liveAuthorization(current, sandbox);
      if (current.authorization !== previous) throw new Error('Preview authorization changed during handoff');
      const physical = await this.readSession(current);
      this.liveAuthorization(current, sandbox);
      this.environment(sandbox, { execution: input.execution, policy: current.policy, expectedEnvironment: current.expectedEnvironment });
      if (replay) {
        if (physical.controlEpoch !== previous.receipt.controlEpoch) throw new Error('Preview control changed after this handoff');
        return previous.receipt;
      }
      if (previous.receipt && physical.controlEpoch <= previous.receipt.controlEpoch) throw new Error('Preview requires a new human return');
      const receipt = matchPreviewHandoffReceipt({ version: 1, handoffId: input.handoffId, requestHash,
        creationRequestHash: current.requestHash, sandboxId: current.id, sessionId: current.sessionId,
        policyDigest: browserPolicyDigest(current.policy), attemptId: input.execution.attemptId, dispatchId: input.execution.dispatchId,
        controlEpoch: physical.controlEpoch, observedAt: new Date().toISOString() }, input, browserPolicyDigest(current.policy));
      current.authorization = { execution: input.execution, payloadHash: requestHash, receipt };
      return receipt;
    });
  }
  /** Called under worker → sandbox → preview locks. Reauthorization does not
   * itself extend a lease; the caller still needs the separate retention grant. */
  authorizeHeartbeat(current) {
    return this.serial(async () => {
      const sandbox = this.sandboxes.sessions.get(current.id);
      const check = () => this.liveAuthorization(current, sandbox);
      check();
      const authorization = current.authorization;
      await this.admission.admit({ execution: authorization.execution, resourceId: authorization.execution.dispatchId, operationId: 'preview:session', kind: 'environment.preview', payloadHash: authorization.payloadHash });
      check();
    });
  }
  async openInside(sandbox, port, input) {
    if (!this.base) throw new Error('App preview is not configured on this worker');
    if (!uuid(sandbox.id)) throw new Error('Invalid preview sandbox identity');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose an app port from 1024 to 65535');
    if (sandbox.status !== 'ready') throw new Error('Start the app in its sandbox before opening a preview');
    const binding = sandbox.execution ? this.environment(sandbox, input) : null;
    if (!binding && input !== undefined) throw new Error('Preview execution cannot be added to a manual sandbox');
    const policy = binding ? parseBrowserPolicy(input.policy) : null;
    if (binding && (!policy || binding.port !== port || Date.parse(policy.deadlineAt) > binding.deadlineAt)) throw new Error('Preview policy or port exceeds its execution');
    const requestHash = binding ? executionHash({ sandboxId: sandbox.id, port, execution: binding.execution, policy, expectedEnvironment: binding.expectedEnvironment }) : null;
    const authorize = async operationId => {
      const expected = this.active;
      if (binding) {
        this.environment(sandbox, input);
        await this.admission.admit({ execution: binding.execution, resourceId: binding.execution.dispatchId, operationId, kind: 'environment.preview', payloadHash: requestHash });
        this.environment(sandbox, input);
      }
      if (!expected || this.active !== expected || expected.closing || expected.expiresAt <= Date.now()) throw new Error('Preview closed during admission');
    };
    if (this.active) {
      if (this.active.id === sandbox.id && this.active.port === port && this.active.session && !this.active.closing) {
        if (this.active.requestHash !== requestHash || this.active.authorization?.receipt) throw new Error('Preview execution or policy changed on replay');
        await authorize('preview:create');
        return this.active.session;
      }
      throw new Error('Preview browser capacity reached. Close the current preview before opening another.');
    }
    const current = { id: sandbox.id, port, name: `qa-preview-${sandbox.id}`, key: randomBytes(32).toString('hex'), expiresAt: Math.min(Date.now() + 1800000, policy ? Date.parse(policy.deadlineAt) : Infinity),
      requestHash, ...(binding ? { execution: binding.execution, expectedEnvironment: binding.expectedEnvironment, policy,
        authorization: { execution: binding.execution, payloadHash: requestHash, receipt: null } } : {}) };
    this.closed.delete(sandbox.id);
    this.active = current;
    try {
      const publicMemory = Number(await this.execute('docker', ['inspect', '-f', '{{.HostConfig.Memory}}', 'qa-browser']));
      if (!publicMemory || publicMemory > 2147483648) throw new Error('Preview requires the public browser pool to have a verified 2 GiB memory limit');
      if (await this.execute('docker', ['network', 'inspect', '-f', '{{.EnableIPv6}}', 'qa-repo-net']) !== 'false') throw new Error('Preview network must have IPv6 disabled');
      if (await this.execute('sysctl', ['-n', 'net.bridge.bridge-nf-call-iptables']) !== '1') throw new Error('Preview requires bridge firewall filtering');
      const target = await this.execute('docker', ['inspect', '-f', '{{(index .NetworkSettings.Networks "qa-repo-net").IPAddress}}', `qa-sandbox-${sandbox.id}`]);
      if (!ip(target)) throw new Error('Sandbox is not on the assigned worker network');
      current.origin = `http://${target}:${port}`;
      if (policy && (policy.allowedOrigins.length !== 1 || policy.allowedOrigins[0] !== current.origin)) throw new Error('Preview policy must name only the assigned application origin');
      await authorize('preview:create');
      await this.execute('docker', ['run', '-d', '--name', current.name, '--label', 'qa.preview=true', '--init', '--network', 'qa-repo-net', '--memory', '1g', '--memory-swap', '1g', '--cpus', '1', '--pids-limit', '256', '--shm-size', '256m', '--security-opt', 'seccomp=/opt/qa-browser/seccomp.json', '--cap-drop', 'ALL', '--cap-add', 'SYS_CHROOT', '-e', `BROWSER_SERVICE_KEY=${current.key}`, '-e', `BROWSER_PUBLIC_URL=${this.base}/preview/${sandbox.id}`, '-e', `BROWSER_PREVIEW_ORIGIN=${current.origin}`, '-e', `EXECUTION_ORIGINS=${allowedOrigins().join(',')}`, '-e', 'BROWSER_MAX_SESSIONS=1', process.env.PREVIEW_BROWSER_IMAGE || 'qa-browser:execution']);
      current.host = await this.execute('docker', ['inspect', '-f', '{{(index .NetworkSettings.Networks "qa-repo-net").IPAddress}}', current.name]);
      if (!ip(current.host) || current.host === target) throw new Error('Invalid preview worker network identity');
      current.rule = ['-s', `${current.host}/32`, '-d', `${target}/32`, '-p', 'tcp', '--dport', String(port), '-j', 'ACCEPT'];
      await authorize('preview:network');
      await this.execute('iptables', ['-A', 'QA_PREVIEW', ...current.rule]);
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try { if ((await this.request(current, '/health', 'GET')).ready) { ready = true; break; } } catch { /* Starting. */ }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (!ready) throw new Error('Preview browser did not become ready');
      await authorize('preview:session');
      const session = await this.request(current, '/sessions', 'POST', policy ? { policy } : undefined);
      if (current.closing || current.expiresAt <= Date.now()) throw new Error('Preview closed during session creation');
      if (policy && (session.policyVersion !== 1 || session.policyDigest !== browserPolicyDigest(policy))) throw new Error('Preview service did not confirm the exact read-only policy');
      current.session = { ...session, previewUrl: current.origin, sandboxId: sandbox.id };
      current.sessionId = session.sessionId;
      return current.session;
    } catch (error) {
      await this.closeInside(sandbox.id);
      // execFile messages can contain container environment arguments. Never
      // forward them to the model, API client or persisted execution log.
      // eslint-disable-next-line preserve-caught-error -- The cause contains the private container key in argv.
      if (error.cmd) throw new Error('Preview infrastructure failed. Check worker runtime, networking and capacity.');
      throw error;
    }
  }
  async request(current, path, method, body) {
    const response = await this.fetch(`http://${current.host}:8080${path}`, { method, headers: { authorization: `Bearer ${current.key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error(`Preview browser request failed (${response.status})`);
    return response.json();
  }
  close(id) {
    if (this.active?.id === id) this.active.closing = true;
    return this.serial(() => this.closeInside(id));
  }
  async closeInside(id) {
    if (!uuid(id)) throw new Error('Invalid preview sandbox identity');
    const current = this.active;
    if (!current || current.id !== id) return this.closed.get(id)?.receipt ?? { sandboxId: id, confirmed: false, observedAt: new Date().toISOString() };
    // Revoke network access before removing the container. Failed cleanup keeps
    // the slot reserved and is retried; it never becomes an untracked browser.
    current.closing = true;
    await this.execute('iptables', ['-F', 'QA_PREVIEW']);
    try { await this.execute('docker', ['rm', '-f', current.name]); }
    catch (error) { if (!String(error.stderr || error.message).includes('No such container')) throw error; }
    this.active = null;
    const receipt = { sandboxId: id, sessionId: current.sessionId ?? null, confirmed: true, observedAt: new Date().toISOString() };
    this.closed.set(id, { receipt, requestHash: current.requestHash }); if (this.closed.size > 64) this.closed.delete(this.closed.keys().next().value);
    return receipt;
  }
  async tick() {
    const current = this.active; if (!current) return;
    const parent = this.sandboxes.sessions.get(current.id);
    if (current.closing || current.expiresAt <= Date.now() || current.authorization && Date.parse(current.authorization.execution.deadlineAt) <= Date.now()
      || !parent || parent.status !== 'ready' || parent.expiresAt <= Date.now()) await this.close(current.id);
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

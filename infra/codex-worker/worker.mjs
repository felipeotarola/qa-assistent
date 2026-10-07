import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { CodexClient, threadOptions, codexProcessIsolationCapability } from './client.mjs';
import { vaultContext } from './vault-context.mjs';
import { canUseCodex, resolveCodexAccess } from './access.mjs';
import { missionExecution } from '../../shared/mission-execution.mjs';
import { ExecutorAdmission, executionHash, sameExecution } from '../execution/admission.mjs';
import { missionEnvironmentExecution, environmentRequestFingerprint, environmentPlanHash } from '../../shared/mission-environment.mjs';

const terminal = job => !['starting', 'running', 'configuring'].includes(job.status);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const tool = (name, description, properties, required = []) => ({ type: 'function', name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
export const tools = [
  tool('report_environment', 'Report repository startup readiness and missing environment variable NAMES, never values. First inspect source/config examples. Supply only variables needed for this task, required or optional with reason. The worker verifies git identity, commit and HTTP status. Call before finishing any app startup task.', {
    repoUrl: { type: 'string' }, root: { type: 'string' }, directory: { type: 'string' }, command: { type: 'string' }, port: { type: 'integer' }, processId: { type: 'string' },
    variables: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, reason: { type: 'string' }, required: { type: 'boolean' } }, required: ['name','reason','required'], additionalProperties: false } },
  }, ['repoUrl','root','directory','command','port','variables']),
  tool('inspect_environment', 'Inspect existing repositories, processes, dependencies and ports before any modification. Reuse matching work.', {}),
  tool('execute', 'Start a command ONLY in the assigned isolated VPS sandbox. Returns processId. Use process to obtain output. Start services on 0.0.0.0; check HTTP health before claiming success.', { command: { type: 'string', maxLength: 16000 }, directory: { type: 'string' } }, ['command']),
  tool('process', 'Read a process log and exit status. Running is not success. Do not busy poll.', { processId: { type: 'string' } }, ['processId']),
  tool('stop_process', 'Stop a process started by this task.', { processId: { type: 'string' } }, ['processId']),
];
export function visibleJob(job) {
  const visible = { ...job }; delete visible.owner; delete visible.userId; delete visible.task; delete visible.commands;
  delete visible.execution; delete visible.toolJournal; delete visible.fingerprint; delete visible.executorStopProof;
  delete visible.environmentExecution; delete visible.environmentJournal; delete visible.sequence;
  return visible;
}
/** Internal completion receipt. Container cleanup and model-process exit are
 * separate facts: stopping one must never imply that the other stopped. */
export function setupCallbackResult(job) {
  return { jobId: job.jobId, id: job.id, workspaceId: job.workspaceId, status: job.status, message: job.message,
    result: job.result, environment: job.environment, updatedAt: job.updatedAt,
    ...(job.execution ? { execution: job.execution, fingerprint: job.fingerprint, sequence: job.sequence || 0, ...(job.environmentExecution ? { environmentExecution: job.environmentExecution } : {}), usage: job.usage, cleanup: job.cleanup || 'not-confirmed', executorStopped: job.executorStopped ?? null, executorStopProof: job.executorStopProof ?? null } : {}) };
}
export class CodexWorker {
  constructor({ directory, sandboxes, inspectionCommand, environments, Client = CodexClient, allowedUser = process.env.CODEX_PILOT_USER_ID, accessMode = process.env.CODEX_ACCESS_MODE, admission = new ExecutorAdmission(), appUrl = process.env.AUTONOMY_APP_URL, secret = process.env.INTERNAL_API_SECRET, fetch: request = globalThis.fetch }) {
    Object.assign(this, { directory, sandboxes, inspectionCommand, environments, Client, admission, appUrl, secret, request });
    this.access = resolveCodexAccess(accessMode, allowedUser);
    this.jobs = new Map(); this.active = new Map(); this.lock = Promise.resolve(); this.writes = new Map();
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.directory)) if (/^[a-f0-9-]{36}\.json$/.test(file)) {
      const job = JSON.parse(await readFile(`${this.directory}/${file}`, 'utf8'));
      const interrupted = !terminal(job);
      if (interrupted) { job.status = 'interrupted'; job.message = 'Codex-workern startades om. Uppdraget spelades inte om.'; job.eventId=randomUUID(); }
      this.jobs.set(job.jobId, job); if(interrupted) await this.save(job);
      const s = this.sandboxes.sessions?.get(job.id);
      if (s?.codex?.jobId === job.jobId) { s.codex = visibleJob(job); await this.sandboxes.save(s); }
    }
  }
  async save(job) {
    job.sequence = (job.sequence || 0) + 1;
    job.updatedAt = new Date().toISOString();
    const path = `${this.directory}/${job.jobId}.json`;
    const data = JSON.stringify(job);
    const pending = (this.writes.get(job.jobId) || Promise.resolve()).catch(() => {}).then(async () => {
      await writeFile(path + '.tmp', data, { mode: 0o600 }); await rename(path + '.tmp', path);
    });
    this.writes.set(job.jobId, pending); await pending;
  }
  async rpc(input, { beforeRetain } = {}) {
    const previous = this.lock;
    let release; this.lock = new Promise(resolve => { release = resolve; }); await previous;
    try {
      if (!uuid(input.userId)) throw new Error('An authenticated app user is required');
      // Turning off admissions must not prevent owners from inspecting or
      // cancelling work already accepted under the previous access policy.
      if (['start', 'configure'].includes(input.action) && !canUseCodex(input.userId, this.access)) throw new Error('Otto is not enabled for this account');
      const s = this.sandboxes.owned(input.id, input.owner);
      if (s.workspaceId !== input.workspaceId) throw new Error('Sandbox not found');
      if (!uuid(input.jobId)) throw new Error('Invalid job ID');
      const job = this.jobs.get(input.jobId);
      if (job && (job.id !== input.id || job.owner !== input.owner || job.userId !== input.userId)) throw new Error('Job not found');
      if (input.action === 'mission_status') {
        if (!job) { const execution = sameExecution(s.execution, input.execution); if (!execution || execution.dispatchId !== input.jobId) throw new Error('Autonomous job not found'); return { absent: true, jobId: input.jobId, id: input.id, execution }; }
        if (!job.execution) throw new Error('Autonomous job not found'); sameExecution(job.execution, input.execution); return setupCallbackResult(job);
      }
      if (input.action === 'mission_retain') {
        if (!job?.execution) throw new Error('Autonomous environment not found');
        sameExecution(job.execution, input.execution);
        return this.sandboxes.serial(job.id, () => this.retainEnvironment(job, beforeRetain));
      }
      if (input.action === 'status') { if (!job) throw new Error('Job not found'); return visibleJob(job); }
      if (input.action === 'cancel') {
        if (!job) throw new Error('Job not found');
        if (job.environmentExecution) sameExecution(job.execution, input.execution);
        if (job.environmentExecution && terminal(job)) {
          // Terminal apply remains retained until an explicit cancel/close.
          // Historical 'confirmed' from manual-stop semantics is insufficient.
          await this.cleanup(job); job.eventId = randomUUID(); await this.update(job);
          return visibleJob(job);
        }
        if(job.status==='configuring') throw new Error('Configuration is being applied. Stop the sandbox to interrupt it.'); await this.finish(job, 'cancelled', 'Codex-uppdraget avbröts.'); return visibleJob(job);
      }
      if (input.action === 'configure') {
        if (job?.execution || input.execution !== undefined || s.execution) throw new Error('Autonomous configuration requires worker-pull consent; pushed credentials are not accepted');
        if (!job?.environment || !this.environments || !uuid(input.attemptId)) throw new Error('Verified environment plan required');
        if (job.configAttemptId === input.attemptId) return visibleJob(job);
        if (!['needs_configuration','failed','completed'].includes(job.status) || this.active.size) throw new Error('Environment is busy or not awaiting configuration');
        job.configAttemptId = input.attemptId; job.status = 'configuring'; job.message = 'Kontrollerar konfiguration och startar om appen';
        this.active.set(job.jobId, {}); await this.update(job);
        // Values are never written into job state or callbacks.
        void this.environments.apply(job,input.values,input.attemptId).then(async environment => {
          job.environment = environment;
          const ready = environment.httpStatus >= 200 && environment.httpStatus < 400;
          job.result = ready ? `Appen svarar med HTTP ${environment.httpStatus} på port ${environment.port}. Miljön kan kontrolleras med de beställda testerna.` : `Konfigurationen tillämpades men HTTP-kontrollen gav ${environment.httpStatus ?? 'inget svar'}. Funktionstester har inte körts.`;
          await this.finish(job, ready ? 'completed' : 'failed', ready ? 'Appen svarar; redo för nästa kontroll' : 'Appstart behöver undersökas');
        }).catch(() => this.finish(job,'failed','Konfigurationen kunde inte tillämpas. Kontrollera miljö, repo och version före nytt försök.')).catch(() => {});
        return visibleJob(job);
      }
      if (input.action !== 'start' || typeof input.task !== 'string' || !input.task.trim() || input.task.length > 12000) throw new Error('Invalid Codex task');
      const execution = input.execution === undefined ? null : missionExecution(input.execution);
      const environmentExecution = input.environmentExecution === undefined ? null : missionEnvironmentExecution(input.environmentExecution);
      if (environmentExecution && (!execution || input.vault !== undefined || !this.environments)) throw new Error('Environment execution requires a bound attempt without pushed Vault context');
      if (execution && Object.keys(input).some(key => !['action', 'id', 'owner', 'workspaceId', 'userId', 'jobId', 'task', 'vault', 'execution', 'environmentExecution'].includes(key))) throw new Error('Unknown autonomous Codex request field');
      if (execution && execution.dispatchId !== input.jobId) throw new Error('Job ID must equal execution dispatch ID');
      const fingerprint = environmentExecution ? environmentRequestFingerprint(execution, input.task, environmentExecution) : execution ? executionHash({ execution, task: input.task, vaultContext: vaultContext(input.vault) }) : null;
      if (job) {
        sameExecution(job.execution, input.execution);
        if (execution && job.fingerprint !== fingerprint) throw new Error('Submission ID already used for another payload');
        if (!isDeepStrictEqual(job.task, input.task)) throw new Error('Submission ID already used for another task');
        return environmentExecution ? setupCallbackResult(job) : visibleJob(job);
      }
      if (environmentExecution?.phase !== 'apply' && !environmentExecution?.approvedPlan && this.Client === CodexClient && !codexProcessIsolationCapability().available) throw new Error('Otto requires available Linux cgroup v2 isolation and confirmed previous process cleanup');
      sameExecution(s.execution, input.execution);
      if (s.credentialBound || this.environments?.values.has(input.id)) throw new Error('This environment contains repository credentials. Use its existing configuration/preview controls; new agent shell tasks require a separate environment.');
      if (s.status !== 'ready') throw new Error('Sandbox is not running');
      if (this.active.size) throw new Error('Otto shared capacity is busy. Try again after the current task finishes; no new job was started.');
      if (environmentExecution) {
        if (s.processes.length || s.codex || s.seededTemplateKey) throw new Error('Environment execution requires a fresh isolated sandbox');
        if (environmentExecution.phase === 'apply') {
          const source = this.jobs.get(environmentExecution.sourceSetupJobId);
          if (!source || !['completed', 'needs_configuration'].includes(source.status) || source.userId !== input.userId || source.workspaceId !== input.workspaceId || source.execution?.runtime !== execution.runtime || source.execution?.missionId !== execution.missionId || source.environmentExecution?.phase !== 'prepare' || source.id === input.id || source.cleanup !== 'confirmed' || source.executorStopped !== true || !source.environment || environmentPlanHash(source.environment) !== environmentExecution.planHash) throw new Error('Prepared environment and confirmed previous cleanup required');
          const sourceSandbox = this.sandboxes.owned(source.id, source.owner);
          if (sourceSandbox.workspaceId !== input.workspaceId || !['stopped', 'expired', 'deleted'].includes(sourceSandbox.status)) throw new Error('Prepared environment physical cleanup changed');
          sameExecution(sourceSandbox.execution, source.execution);
        }
      }
      const created = { jobId: input.jobId, id: input.id, owner: input.owner, workspaceId: input.workspaceId, userId: input.userId, task: input.task, ...(environmentExecution ? { environmentExecution, environmentJournal: {} } : { vaultContext: vaultContext(input.vault) }), ...(execution ? { execution, fingerprint, toolJournal: {}, usage: environmentExecution?.phase === 'apply' || environmentExecution?.approvedPlan ? { providerCalls: 0, tokens: 0, accounting: environmentExecution.phase === 'apply' ? 'deterministic-apply' : 'deterministic-prepare' } : { providerCalls: null, tokens: null, accounting: 'whole-turn-reservation' } } : {}), status: 'starting', message: 'Codex förbereder uppdraget', processes: [], commands: {}, inspected: false, createdAt: new Date().toISOString() };
      this.jobs.set(created.jobId, created); this.active.set(created.jobId, {}); await this.save(created);
      void this.run(created).catch(() => this.finish(created, 'failed', 'Codex kunde inte slutföra uppdraget. Kontrollera inloggning och worker.')).catch(() => {});
      return environmentExecution ? setupCallbackResult(created) : visibleJob(created);
    } finally { release(); }
  }
  scope(job) { return { id: job.id, owner: job.owner, workspaceId: job.workspaceId, ...(job.execution ? { execution: job.execution } : {}) }; }
  async cleanup(job) {
    const s = this.sandboxes.owned(job.id, job.owner); sameExecution(s.execution, job.execution);
    try {
      const receipt = await this.sandboxes.serial(job.id, () => this.sandboxes.close(s, 'deleted'));
      if (receipt?.confirmed !== true || receipt.resourceId !== job.id || receipt.executionHash !== executionHash(job.execution)) throw new Error('Sandbox destruction receipt is unavailable');
      job.cleanup = 'confirmed';
    } catch { job.cleanup = 'unknown'; }
  }
  async authorize(job, operationId, kind, payload) {
    if (!job.execution) return;
    if (terminal(job) || !this.active.has(job.jobId)) throw new Error('Job is not active');
    await this.admission.admit({ execution: job.execution, resourceId: job.id, operationId, kind, payloadHash: executionHash(payload) });
    if (terminal(job) || !this.active.has(job.jobId)) throw new Error('Job is not active');
  }
  /** Lease renewal is not a new execution or a deadline extension. The app
   * rechecks consent on every pull; a missing receipt never renews locally. */
  async retainEnvironment(job, beforeRetain) {
    const validate = () => {
      const state = this.sandboxes.owned(job.id, job.owner);
      sameExecution(state.execution, job.execution);
      if (job.environmentExecution?.phase !== 'apply' || job.status !== 'completed' || job.cleanup !== 'retained' || job.executorStopped !== true
        || state.workspaceId !== job.workspaceId || state.status !== 'ready' || !Number.isFinite(state.expiresAt) || state.expiresAt <= Date.now() || Date.parse(job.execution.deadlineAt) <= Date.now()
        || !uuid(job.environment?.processId) || !state.processes.some(p => p.id === job.environment.processId && p.status === 'running')
        || environmentPlanHash(job.environment) !== job.environmentExecution.planHash) throw new Error('Retained environment is no longer current');
      return state;
    };
    validate();
    // A cached running flag cannot prove that Docker/the original process lives.
    const name = `qa-sandbox-${job.id}`;
    if ((await this.sandboxes.execute(['inspect', '--format', '{{.State.Running}}', name])).trim() !== 'true') throw new Error('Environment container is not running');
    const alive = await this.sandboxes.execute(['exec', name, 'node', '-e', "const f=require('fs');const p=JSON.parse(f.readFileSync(process.argv[1],'utf8'));if(p.id!==process.argv[2]||p.status!=='running'||!Number.isSafeInteger(p.pid)||p.pid<=1)throw Error('Process unavailable');process.kill(p.pid,0);console.log('running')", `/tmp/qa-processes/${job.environment.processId}.json`, job.environment.processId]);
    if (alive.trim() !== 'running') throw new Error('Environment process is not running');
    validate();
    if (!this.appUrl || typeof this.secret !== 'string' || this.secret.length < 32) throw new Error('Environment retention admission is unavailable');
    const url = new URL(this.appUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Invalid retention endpoint');
    url.pathname = '/api/internal/environment-retain';
    let receipt;
    try {
      const response = await this.request(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ execution: job.execution, resourceId: job.id, jobId: job.jobId }) });
      if (!response.ok) throw new Error('Denied');
      const reader = response.body?.getReader(); if (!reader) throw new Error('Missing receipt');
      let size = 0; const chunks = [];
      try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 4096) throw new Error('Oversized receipt'); chunks.push(part.value); } }
      finally { await reader.cancel().catch(() => {}); }
      receipt = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new Error('Environment retention denied or unavailable'); }
    const validUntil = Date.parse(receipt?.validUntil), retainUntil = Date.parse(receipt?.retainUntil), now = Date.now();
    if (!receipt || Object.keys(receipt).length !== 3 || receipt.allowed !== true || typeof receipt.validUntil !== 'string' || typeof receipt.retainUntil !== 'string' || !Number.isFinite(validUntil) || validUntil <= now || validUntil > now + 5000
      || !Number.isFinite(retainUntil) || retainUntil <= now || retainUntil > Math.min(Date.parse(job.execution.deadlineAt), now + Math.min(300000, this.sandboxes.leaseMs))
      || validUntil > retainUntil) throw new Error('Invalid environment retention receipt');
    // Preview heartbeats additionally require the original operating attempt.
    // This callback is server-owned, never part of the wire payload.
    await beforeRetain?.();
    const state = validate();
    if (validUntil <= Date.now() || retainUntil <= Date.now()) throw new Error('Environment retention receipt expired');
    state.expiresAt = retainUntil; await this.sandboxes.save(state);
    return { retained: true, jobId: job.jobId, id: job.id, expiresAt: new Date(retainUntil).toISOString() };
  }
  hasActive(id) { return [...this.active.keys()].some(jobId => this.jobs.get(jobId).id === id); }
  environmentLifecycle(job) { return { active: () => !terminal(job) && this.active.has(job.jobId), save: () => this.save(job), authorize: (...args) => this.authorize(job, ...args) }; }
  async update(job) {
    await this.save(job);
    await this.sandboxes.serial(job.id, async () => {
      const s = this.sandboxes.owned(job.id, job.owner);
      s.codex = visibleJob(job); await this.sandboxes.save(s);
    });
  }
  call(job, toolName, args, operationId) {
    const active = this.active.get(job.jobId);
    if (!active) return Promise.reject(new Error('Job is not active'));
    const operation = (active.operation || Promise.resolve()).catch(() => {}).then(async () => {
      if (!job.execution) return this.perform(job, toolName, args);
      if (typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(operationId)) throw new Error('Stable tool call identity required');
      const payloadHash = executionHash({ toolName, args });
      const previous = job.toolJournal[operationId];
      if (previous) {
        if (previous.payloadHash !== payloadHash) throw new Error('Tool call identity reused with different arguments');
        if (previous.state === 'completed') return previous.result;
        throw new Error('Previous tool outcome is unknown or denied; automatic replay is not permitted');
      }
      if (Object.keys(job.toolJournal).length >= 300) throw new Error('Tool journal limit reached');
      job.toolJournal[operationId] = { payloadHash, state: 'unknown' }; await this.save(job);
      await this.authorize(job, operationId, 'codex.tool', { toolName, args });
      const result = await this.perform(job, toolName, args, operationId);
      job.toolJournal[operationId] = { payloadHash, state: 'completed', result }; await this.save(job);
      return result;
    });
    active.operation = operation; return operation;
  }
  async perform(job, toolName, args, operationId) {
    if (terminal(job) || !this.active.has(job.jobId)) throw new Error('Job is not active');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tool arguments');
    const rpc = input => this.sandboxes.rpc({ ...input, ...this.scope(job), ...(operationId ? { operationId } : {}) });
    if (toolName === 'report_environment') {
      if (job.environmentExecution?.phase === 'prepare') {
        if (!job.inspected) throw new Error('Inspect the environment first');
        job.environment = await this.environments.inspectMission(job, args, this.environmentLifecycle(job)); await this.update(job); return job.environment;
      }
      if (job.execution) throw new Error('Autonomous environment verification requires a frozen-plan request');
      if (!job.inspected || !this.environments) throw new Error('Inspect the environment first');
      if (args.processId && (!job.processes.includes(args.processId) || job.commands?.[args.processId]?.command !== args.command || job.commands?.[args.processId]?.directory !== args.directory)) throw new Error('Start command and process must match an observed execute call');
      if (!args.processId && args.variables?.some(v=>v.required)) throw new Error('Start the service with execute and identify its process before requesting configuration');
      job.environment = await this.environments.inspect(job,args); await this.update(job);
      return job.environment;
    }
    if (toolName === 'inspect_environment' || toolName === 'execute') {
      if (toolName === 'execute' && !job.inspected) throw new Error('Inspect the environment first');
      const command = toolName === 'inspect_environment' ? this.inspectionCommand() : args.command;
      if (typeof command !== 'string' || !command.trim() || command.length > 16000) throw new Error('Invalid command');
      const processId = randomUUID(); job.processes.push(processId); await this.save(job);
      job.commands ||= {}; job.commands[processId] = { command, directory: args.directory || '/workspace' }; await this.save(job);
      await rpc({ action: 'spawn', command, processId, workingDirectory: args.directory || '/workspace' });
      job.message = toolName === 'execute' ? 'Codex kör ett kommando i arbetsmiljön' : 'Codex undersöker befintlig arbetsmiljö';
      await this.update(job);
      return { processId, status: 'starting', note: 'Read process output before drawing conclusions.' };
    }
    if (!['process', 'stop_process'].includes(toolName) || !job.processes.includes(args.processId)) throw new Error('Tool or process not permitted');
    const result = await rpc({ action: toolName === 'process' ? 'process' : 'kill', processId: args.processId });
    if (args.processId === job.processes[0] && result.status === 'completed' && result.exitCode === 0) job.inspected = true;
    await this.save(job);
    return this.environments?.redact(job.id, { ...result, stdout: result.stdout.slice(-24000), stderr: result.stderr.slice(-8000) }) || { ...result, stdout: result.stdout.slice(-24000), stderr: result.stderr.slice(-8000) };
  }
  async run(job) {
    const active = this.active.get(job.jobId);
    if (job.environmentExecution) {
      active.timer = setTimeout(() => { void this.finish(job, 'timeout', 'Miljön nådde uppdragets tidsgräns.').catch(() => {}); }, Math.max(1, Date.parse(job.execution.deadlineAt) - Date.now()));
      if (job.environmentExecution.phase === 'apply') {
        active.operation = this.environments.applyMission(job, this.environmentLifecycle(job));
        job.environment = await active.operation;
        const ready = job.environment.httpStatus >= 200 && job.environment.httpStatus < 400;
        job.result = ready ? 'Appen svarar på HTTP. Funktionstester återstår.' : 'Appens HTTP-kontroll lyckades inte. Funktionstester har inte körts.';
        await this.finish(job, ready ? 'completed' : 'failed', ready ? 'Testmiljön svarar' : 'Testmiljön kunde inte starta'); return;
      }
      active.operation = this.environments.prepareMission(job, this.environmentLifecycle(job)); await active.operation;
      if (job.environmentExecution.approvedPlan) {
        active.operation = this.environments.verifyApprovedMission(job, this.environmentLifecycle(job));
        job.environment = await active.operation;
        job.result = 'Den godkända startplanens exakta checkout och körprofil har verifierats på nytt utan modell. Appstart och funktionstester återstår.';
        await this.finish(job, 'completed', 'Godkänd startplan verifierad på nytt');
        return;
      }
    }
    const admitted = (operationId, kind, operation) => this.sandboxes.serial(job.id, async () => {
      const s = this.sandboxes.owned(job.id, job.owner);
      if (s.status !== 'ready') throw new Error('Sandbox stopped');
      sameExecution(s.execution, job.execution);
      await this.authorize(job, operationId, kind, { fingerprint: job.fingerprint || null });
      return operation();
    });
    // The app-server owns opaque internal provider requests. Admit before its
    // process exists, and reserve the whole turn; never invent per-call usage.
    const client = await admitted('initialize:spawn', 'codex.initialize', () => new this.Client({
      onExit: () => { void this.finish(job, 'interrupted', 'Codex-processen stoppades oväntat.').catch(() => {}); },
      onRequest: async msg => {
        if (msg.method !== 'item/tool/call') throw new Error('Only scoped sandbox tools are permitted');
        try {
          if (job.execution && !['string', 'number'].includes(typeof msg.id)) throw new Error('Missing stable RPC call identity');
          return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(await this.call(job, msg.params.tool, msg.params.arguments, job.execution ? `rpc:${executionHash({ id: msg.id })}` : undefined)) }] };
        }
        catch (error) { return { success: false, contentItems: [{ type: 'inputText', text: error.message }] }; }
      },
      onEvent: msg => {
        if (msg.method === 'item/completed' && msg.params.item.type === 'agentMessage') job.result = this.environments?.redact(job.id,msg.params.item.text.slice(-16000)) || msg.params.item.text.slice(-16000);
        if (msg.method === 'turn/completed') void this.finish(job, msg.params.turn.status === 'completed' ? 'completed' : 'failed', msg.params.turn.status === 'completed' ? 'Codex har rapporterat resultat. Se verifierade kommandon i loggen.' : 'Codex-uppdraget misslyckades.').catch(() => {});
      },
    }));
    active.client = client;
    if (!active.timer) active.timer = setTimeout(() => { void this.finish(job, 'timeout', 'Codex nådde uppdragets tidsgräns.').catch(() => {}); }, Math.max(1, Math.min(20 * 60 * 1000, job.execution ? Date.parse(job.execution.deadlineAt) - Date.now() : Infinity)));
    active.heartbeat = setInterval(() => {
      void this.sandboxes.serial(job.id, async () => {
        const s = this.sandboxes.owned(job.id, job.owner);
        if (s.status !== 'ready') throw new Error('Sandbox stopped');
        await this.authorize(job, 'turn', 'codex.turn', { fingerprint: job.fingerprint || null });
        s.expiresAt = Date.now() + this.sandboxes.leaseMs; await this.sandboxes.save(s);
      }).catch(() => this.finish(job, 'interrupted', 'Arbetsmiljön stoppades.')).catch(() => {});
    }, 20000);
    await admitted('initialize:protocol', 'codex.initialize', () => client.initialize());
    const result = await admitted('initialize:thread', 'codex.initialize', () => client.request('thread/start', {
      ...threadOptions, dynamicTools: tools,
      developerInstructions: job.environmentExecution ? 'Prepare an immutable startup plan for the pinned repository already checked out at /workspace/repository. Inspect source and package/config files. Do not modify tracked source. Use only the supplied scoped tools. Never obtain secret values. report_environment must contain the exact repository, project directory, command, port and necessary variable NAMES. You may report a verified plan without starting the app or providing processId. A different deterministic attempt will install and run the approved plan. Report preparation honestly, never call it a passing functional test. Use Swedish.' : 'You are the QAA repository specialist. All repository work MUST use the provided isolated VPS tools. Inspect first, read its output, and reuse existing matching checkouts, dependencies and services. Never overwrite local changes. Do not modify application source unless the task explicitly requests fixes. Diagnose install/start failures; never call lint a running app or command success a passing functional test. Start servers on 0.0.0.0 and verify HTTP readiness. Return the verified port for Eve to open its existing preview tool. Never access host files, credentials or other users. Do not deploy or push. Use Swedish for the final report. Explain missing prerequisites honestly. Keep the final report normally under 100 words, with Resultat, Hinder only when relevant, and one recommended Nästa steg. Separate setup/worker failures from observed product defects; unknown causes stay unknown. Include the verified port or essential evidence reference, not a transcript of all commands. Do not narrate every tool call. Before finishing an app startup task, call report_environment with the exact repo URL/root, app directory, command and processId from your execute call, and port. Include only missing variable names relevant to this task, with a reason and required flag; never values. Optional streaming configuration must not block unrelated page tests. Do not claim HTTP 500 is ready.',
    }));
    if (terminal(job)) return;
    job.status = 'running'; job.message = 'Codex arbetar med repot'; await this.update(job);
    const context = job.environmentExecution ? `Prepare an immutable environment plan for ${job.environmentExecution.repoUrl} at exact commit ${job.environmentExecution.commit}. The clean checkout is already at /workspace/repository. Inspect code only as needed; never request or read secret values. Do not modify tracked source. Call report_environment even when the app cannot start: a verified command, directory, port and required variable NAMES are sufficient, without processId or a live server. A separate model-free attempt will install and start the approved plan in a fresh environment. The current environment will be stopped when this preparation finishes.` : job.vaultContext || vaultContext();
    await admitted('turn', 'codex.turn', () => client.request('turn/start', { threadId: result.thread.id, input: [{ type: 'text', text: `${job.task}\n\n${context}`, text_elements: [] }] }));
  }
  async finish(job, status, message) {
    if (terminal(job)) return;
    if (status === 'completed' && job.environmentExecution?.phase === 'prepare') {
      status = job.environment ? job.environment.variables.some(v => v.required) ? 'needs_configuration' : 'completed' : 'failed';
      message = job.environment ? 'Verifierad startplan sparad. Appstart och funktionstester återstår.' : 'Ingen verifierad startplan kunde sparas.';
    } else if (status === 'completed' && job.environment && !(job.environment.httpStatus >= 200 && job.environment.httpStatus < 400)) {
      status = job.environment.variables.some(v=>v.required) && !job.configAttemptId ? 'needs_configuration' : 'failed';
      message = status === 'needs_configuration' ? 'Behöver miljökonfiguration. Funktionstester har inte startat.' : 'Appen svarar inte som förväntat. Funktionstester är inte verifierade.';
    }
    job.status = status; job.message = message;
    const active = this.active.get(job.jobId);
    clearInterval(active?.heartbeat); clearTimeout(active?.timer);
    let stopped = true;
    try { await active?.client?.close(); } catch { stopped = false; }
    if (job.execution) { job.executorStopped = stopped; job.executorStopProof = stopped ? active?.client?.stopReceipt ?? null : null; }
    await active?.operation?.catch(() => {});
    if (job.environmentExecution?.phase === 'prepare' || !['completed','needs_configuration'].includes(status)) {
      if (job.execution) {
        await this.cleanup(job);
      } else for (const processId of job.processes) await this.sandboxes.rpc({ ...this.scope(job), action: 'kill', processId }).catch(() => {});
    }
    if (job.environmentExecution?.phase === 'apply' && status === 'completed') job.cleanup = 'retained';
    job.eventId = randomUUID();
    // Never admit a second shared Otto job merely because SIGTERM was sent.
    // Unconfirmed physical exit retains capacity until supervised recovery.
    try { await this.update(job); } finally { if (stopped) this.active.delete(job.jobId); }
  }
  async close() { for (const id of this.active.keys()) await this.finish(this.jobs.get(id), 'interrupted', 'Workern stoppades.'); }
}

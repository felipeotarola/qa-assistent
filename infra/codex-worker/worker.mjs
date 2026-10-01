import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { CodexClient, threadOptions } from './client.mjs';

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
  return visible;
}
export class CodexWorker {
  constructor({ directory, sandboxes, inspectionCommand, environments, Client = CodexClient, allowedUser = process.env.CODEX_PILOT_USER_ID }) {
    Object.assign(this, { directory, sandboxes, inspectionCommand, environments, Client, allowedUser });
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
    job.updatedAt = new Date().toISOString();
    const path = `${this.directory}/${job.jobId}.json`;
    const data = JSON.stringify(job);
    const pending = (this.writes.get(job.jobId) || Promise.resolve()).catch(() => {}).then(async () => {
      await writeFile(path + '.tmp', data, { mode: 0o600 }); await rename(path + '.tmp', path);
    });
    this.writes.set(job.jobId, pending); await pending;
  }
  async rpc(input) {
    const previous = this.lock;
    let release; this.lock = new Promise(resolve => { release = resolve; }); await previous;
    try {
      if (!this.allowedUser || input.userId !== this.allowedUser) throw new Error('Codex subscription pilot is not enabled for this account');
      const s = this.sandboxes.owned(input.id, input.owner);
      if (s.workspaceId !== input.workspaceId) throw new Error('Sandbox not found');
      if (!uuid(input.jobId)) throw new Error('Invalid job ID');
      const job = this.jobs.get(input.jobId);
      if (job && (job.id !== input.id || job.owner !== input.owner || job.userId !== input.userId)) throw new Error('Job not found');
      if (input.action === 'status') { if (!job) throw new Error('Job not found'); return visibleJob(job); }
      if (input.action === 'cancel') { if (!job) throw new Error('Job not found'); if(job.status==='configuring') throw new Error('Configuration is being applied. Stop the sandbox to interrupt it.'); await this.finish(job, 'cancelled', 'Codex-uppdraget avbröts.'); return visibleJob(job); }
      if (input.action === 'configure') {
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
      if (job) {
        if (!isDeepStrictEqual(job.task, input.task)) throw new Error('Submission ID already used for another task');
        return visibleJob(job);
      }
      if (this.environments?.values.has(input.id)) throw new Error('This environment contains repository credentials. Use its existing configuration/preview controls; new agent shell tasks require a separate environment.');
      if (s.status !== 'ready') throw new Error('Sandbox is not running');
      if (this.active.size) throw new Error('Codex pilot is busy. Inspect the existing job before submitting another.');
      const created = { jobId: input.jobId, id: input.id, owner: input.owner, workspaceId: input.workspaceId, userId: input.userId, task: input.task, status: 'starting', message: 'Codex förbereder uppdraget', processes: [], commands: {}, inspected: false, createdAt: new Date().toISOString() };
      this.jobs.set(created.jobId, created); this.active.set(created.jobId, {}); await this.save(created);
      void this.run(created).catch(() => this.finish(created, 'failed', 'Codex kunde inte slutföra uppdraget. Kontrollera inloggning och worker.')).catch(() => {});
      return visibleJob(created);
    } finally { release(); }
  }
  scope(job) { return { id: job.id, owner: job.owner, workspaceId: job.workspaceId }; }
  hasActive(id) { return [...this.active.keys()].some(jobId => this.jobs.get(jobId).id === id); }
  async update(job) {
    await this.save(job);
    await this.sandboxes.serial(job.id, async () => {
      const s = this.sandboxes.owned(job.id, job.owner);
      s.codex = visibleJob(job); await this.sandboxes.save(s);
    });
  }
  call(job, toolName, args) {
    const active = this.active.get(job.jobId);
    if (!active) return Promise.reject(new Error('Job is not active'));
    const operation = (active.operation || Promise.resolve()).catch(() => {}).then(() => this.perform(job, toolName, args));
    active.operation = operation; return operation;
  }
  async perform(job, toolName, args) {
    if (terminal(job) || !this.active.has(job.jobId)) throw new Error('Job is not active');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tool arguments');
    const rpc = input => this.sandboxes.rpc({ ...input, ...this.scope(job) });
    if (toolName === 'report_environment') {
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
    const client = new this.Client({
      onExit: () => { void this.finish(job, 'interrupted', 'Codex-processen stoppades oväntat.').catch(() => {}); },
      onRequest: async msg => {
        if (msg.method !== 'item/tool/call') throw new Error('Only scoped sandbox tools are permitted');
        try { return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(await this.call(job, msg.params.tool, msg.params.arguments)) }] }; }
        catch (error) { return { success: false, contentItems: [{ type: 'inputText', text: error.message }] }; }
      },
      onEvent: msg => {
        if (msg.method === 'item/completed' && msg.params.item.type === 'agentMessage') job.result = this.environments?.redact(job.id,msg.params.item.text.slice(-16000)) || msg.params.item.text.slice(-16000);
        if (msg.method === 'turn/completed') void this.finish(job, msg.params.turn.status === 'completed' ? 'completed' : 'failed', msg.params.turn.status === 'completed' ? 'Codex har rapporterat resultat. Se verifierade kommandon i loggen.' : 'Codex-uppdraget misslyckades.').catch(() => {});
      },
    });
    active.client = client;
    active.timer = setTimeout(() => { void this.finish(job, 'timeout', 'Codex nådde tidsgränsen på 20 minuter.').catch(() => {}); }, 20 * 60 * 1000);
    active.heartbeat = setInterval(() => {
      void this.sandboxes.serial(job.id, async () => {
        const s = this.sandboxes.owned(job.id, job.owner);
        if (s.status !== 'ready') throw new Error('Sandbox stopped');
        s.expiresAt = Date.now() + this.sandboxes.leaseMs; await this.sandboxes.save(s);
      }).catch(() => this.finish(job, 'interrupted', 'Arbetsmiljön stoppades.')).catch(() => {});
    }, 20000);
    await client.initialize();
    const result = await client.request('thread/start', {
      ...threadOptions, dynamicTools: tools,
      developerInstructions: 'You are the QAA repository specialist. All repository work MUST use the provided isolated VPS tools. Inspect first, read its output, and reuse existing matching checkouts, dependencies and services. Never overwrite local changes. Do not modify application source unless the task explicitly requests fixes. Diagnose install/start failures; never call lint a running app or command success a passing functional test. Start servers on 0.0.0.0 and verify HTTP readiness. Return the verified port for Eve to open its existing preview tool. Never access host files, credentials or other users. Do not deploy or push. Use Swedish for the final report. Explain missing prerequisites honestly. Keep the final report normally under 100 words, with Resultat, Hinder only when relevant, and one recommended Nästa steg. Separate setup/worker failures from observed product defects; unknown causes stay unknown. Include the verified port or essential evidence reference, not a transcript of all commands. Do not narrate every tool call. Before finishing an app startup task, call report_environment with the exact repo URL/root, app directory, command and processId from your execute call, and port. Include only missing variable names relevant to this task, with a reason and required flag; never values. Optional streaming configuration must not block unrelated page tests. Do not claim HTTP 500 is ready.',
    });
    if (terminal(job)) return;
    job.status = 'running'; job.message = 'Codex arbetar med repot'; await this.update(job);
    await client.request('turn/start', { threadId: result.thread.id, input: [{ type: 'text', text: job.task, text_elements: [] }] });
  }
  async finish(job, status, message) {
    if (terminal(job)) return;
    if (status === 'completed' && job.environment && !(job.environment.httpStatus >= 200 && job.environment.httpStatus < 400)) {
      status = job.environment.variables.some(v=>v.required) && !job.configAttemptId ? 'needs_configuration' : 'failed';
      message = status === 'needs_configuration' ? 'Behöver miljökonfiguration. Funktionstester har inte startat.' : 'Appen svarar inte som förväntat. Funktionstester är inte verifierade.';
    }
    job.status = status; job.message = message;
    const active = this.active.get(job.jobId);
    clearInterval(active?.heartbeat); clearTimeout(active?.timer); active?.client?.close();
    await active?.operation?.catch(() => {});
    if (!['completed','needs_configuration'].includes(status)) for (const processId of job.processes) {
      await this.sandboxes.rpc({ ...this.scope(job), action: 'kill', processId }).catch(() => {});
    }
    job.eventId = randomUUID();
    try { await this.update(job); } finally { this.active.delete(job.jobId); }
  }
  async close() { for (const id of this.active.keys()) await this.finish(this.jobs.get(id), 'interrupted', 'Workern stoppades.'); }
}

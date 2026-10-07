import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Runner, terminal } from './runner.mjs';
import { ExecutionStore, validId } from '../execution/store.mjs';
import { ResultOutbox } from '../execution/outbox.mjs';
import { issueSubscription, verifySubscription, serveEvents } from '../execution/stream.mjs';
import { readJson, allowedOrigins } from '../execution/http.mjs';
import { ResourceBudget } from '../execution/budget.mjs';
import { Sandboxes } from './sandbox.mjs';
import { workerHealth } from '../execution/health.mjs';
import { SandboxStorage } from '../execution/storage.mjs';
import { Previews } from './preview.mjs';
import { CodexWorker, setupCallbackResult } from '../codex-worker/worker.mjs';
import { codexProcessIsolationCapability } from '../codex-worker/client.mjs';
import { EnvironmentManager } from '../codex-worker/environment.mjs';
import { environmentInspectionCommand } from '../codex-worker/environment-inspection.mjs';

const key = process.env.REPO_RUNNER_KEY;
if (!key || key.length < 32) throw new Error('REPO_RUNNER_KEY required');
const directory = process.env.REPO_RUNNER_DATA || '/var/lib/qa-repo-runner';
const events = new ExecutionStore(`${directory}/events`);
const budget = new ResourceBudget();
const sandboxes = new Sandboxes({ directory: `${directory}/sandboxes`, events, budget });
await sandboxes.init();
const environments = new EnvironmentManager({ directory: `${directory}/environment-redaction`, sandboxes });
await environments.init();
const codex = new CodexWorker({ directory: `${directory}/codex`, sandboxes, environments, inspectionCommand: environmentInspectionCommand });
await codex.init();
const previews = new Previews({ sandboxes, base: process.env.REPO_PUBLIC_URL, environmentJob: id => codex.jobs.get(id) });
await previews.init();
sandboxes.onClose = id => previews.close(id);
// Browser subscriptions receive presentation state, never execution authority
// or replay journals. Private REST and callbacks retain the exact binding.
const visibleRepositoryJob = job => {
  const visible = { ...job };
  delete visible.execution; delete visible.fingerprint; delete visible.commandJournal;
  return visible;
};
const runner = new Runner({ directory, budget, storage: new SandboxStorage(`${directory}/repo-disks`, 4), onState: job => events.publish(job.id, 'repository', terminal(job.status) ? 'completed' : 'progress', visibleRepositoryJob(job)) });
await runner.init();
const health = workerHealth(directory, budget);
const callbackConfigured = !!(process.env.REPO_APP_URL && process.env.INTERNAL_API_SECRET);
const codexOutbox = new ResultOutbox({ directory: `${directory}/codex-delivery`, deliver: async event => {
  const response = await fetch(`${process.env.REPO_APP_URL}/api/internal/setup-result`, { method:'POST', headers:{ authorization:`Bearer ${process.env.INTERNAL_API_SECRET}`, 'content-type':'application/json' }, body:JSON.stringify(event.result), signal:AbortSignal.timeout(15000) });
  return response.status;
} });
let callbackProtocol = 0, protocolCheckedAt = 0;
const outbox = new ResultOutbox({ directory: `${directory}/delivery`, deliver: async job => {
  if (job.plan) {
    if (Date.now() - protocolCheckedAt > 30000) {
      protocolCheckedAt = Date.now();
      const response = await fetch(`${process.env.REPO_APP_URL}/api/internal/execution-capabilities`, { headers: { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}` }, signal: AbortSignal.timeout(5000) });
      callbackProtocol = response.ok ? (await response.json()).protocol : 0;
    }
    // An old app strips plan fields. Keep delivery pending until it is upgraded.
    if (callbackProtocol < 1) return 503;
  }
  const response = await fetch(`${process.env.REPO_APP_URL}/api/internal/repository-result`, {
    method: 'POST', headers: { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify(job), signal: AbortSignal.timeout(10000),
  });
  return response.status;
} });
const reply = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const preview = previews.match(req.url);
    if (preview && preview.path === '/viewer' && req.method === 'GET') return previews.proxy(req, res, preview);
    if (url.pathname === '/events' && req.method === 'GET') {
      const claims = verifySubscription(key, url.searchParams.get('token'), req.headers.origin);
      if (!claims) return reply(res, 401, { error: 'Subscription expired or invalid' });
      return await serveEvents(req, res, events, claims);
    }
    const actual = req.headers.authorization || '', expected = `Bearer ${key}`;
    if (Buffer.byteLength(actual) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) return reply(res, 401, { error: 'Unauthorized' });
    if (url.pathname.startsWith('/preview/')) {
      if (!preview) return reply(res, 404, { error: 'Preview closed' });
      if (preview.path === '/heartbeat' && req.method === 'POST') {
        const parent = sandboxes.sessions.get(preview.current.id);
        if (!parent) throw new Error('Preview environment is unavailable');
        if (parent.execution) {
          const job = codex.jobs.get(preview.current.expectedEnvironment?.jobId);
          if (!job) throw new Error('Preview environment is unavailable');
          await codex.rpc({ action: 'mission_retain', id: parent.id, owner: parent.owner, userId: job.userId, workspaceId: parent.workspaceId, jobId: job.jobId, execution: job.execution }, { beforeRetain: () => previews.authorizeHeartbeat(preview.current) });
        } else await sandboxes.serial(parent.id, async () => { parent.expiresAt = Math.min(Date.now() + sandboxes.leaseMs, preview.current.expiresAt); await sandboxes.save(parent); });
        return reply(res, 200, { renewed: true });
      }
      const sessionPath = preview.path.match(/^\/sessions\/([a-f0-9-]{36})(\/(human|agent|redaction|observation))?(\?scoped=1)?$/);
      if (!sessionPath || sessionPath[1] !== preview.current.sessionId) return reply(res, 404, { error: 'Preview endpoint not found' });
      if (req.method === 'DELETE') { await previews.close(preview.current.id); return reply(res, 200, { closed: true }); }
      return previews.proxy(req, res, preview);
    }
    if (url.pathname === '/preview' && req.method === 'POST') {
      const input = await readJson(req);
      if (runner.stopping && !['target', 'status', 'close'].includes(input.action)) return reply(res, 503, { error: 'Worker is draining' });
      const sandbox = sandboxes.owned(input.id, input.owner);
      if (sandbox.workspaceId !== input.workspaceId) return reply(res, 404, { error: 'Sandbox not found' });
      if (sandbox.execution) {
        if (input.action === 'handoff') {
          if (Object.keys(input).some(key => !['action', 'id', 'owner', 'workspaceId', 'handoff'].includes(key))) return reply(res, 400, { error: 'Invalid preview handoff envelope' });
          return reply(res, 200, await sandboxes.serial(sandbox.id, () => previews.handoff(sandbox, input.handoff)));
        }
        const bound = { execution: input.execution, expectedEnvironment: input.expectedEnvironment, ...(input.policy === undefined ? {} : { policy: input.policy }) };
        if (!['target', 'open', 'status', 'close'].includes(input.action)) return reply(res, 400, { error: 'Choose an autonomous preview action' });
        return reply(res, 200, await sandboxes.serial(sandbox.id, () => input.action === 'target' ? previews.target(sandbox, bound)
          : input.action === 'status' ? previews.status(sandbox, input.port, bound)
          : input.action === 'close' ? previews.closeBound(sandbox, input.port, bound)
          : previews.open(sandbox, input.port, bound)));
      }
      if (input.execution !== undefined || input.expectedEnvironment !== undefined || input.policy !== undefined || input.handoff !== undefined || input.action === 'handoff') return reply(res, 400, { error: 'Execution cannot be added to a manual preview' });
      return reply(res, 200, await sandboxes.serial(sandbox.id, () => previews.open(sandbox, input.port)));
    }
    if (url.pathname === '/health') { const status = await health(), processIsolation = codexProcessIsolationCapability(); return reply(res, status.ready ? 200 : 503, { ...status, draining: runner.stopping, active: runner.controllers.size, queued: [...runner.jobs.values()].filter(job => job.status === 'queued').length, callbackConfigured, callbackProtocol, protocol: 1, autonomousExecution: { version: 1, admission: !!(process.env.AUTONOMY_APP_URL && process.env.INTERNAL_API_SECRET), frozenCommit: true, codexTurnAdmission: processIsolation.available, processIsolation, environmentExecution: 1, vaultPull: !!(process.env.AUTONOMY_APP_URL && process.env.INTERNAL_API_SECRET) } }); }
    if (url.pathname === '/drain' && req.method === 'POST') { runner.stopping = true; return reply(res, 200, { draining: true }); }
    if (url.pathname === '/templates' && req.method === 'POST') {
      const input = await readJson(req, 3200000);
      return reply(res, 200, await sandboxes.templates.put(input.templateKey, input.files));
    }
    if (url.pathname === '/sandbox' && req.method === 'POST') {
      const input = await readJson(req, 34000000);
      if (environments.values.has(input.id) && ['spawn','read','write','remove'].includes(input.action)) return reply(res,409,{error:'This environment is configured with repository credentials. Agent shell/file access is disabled; use preview and redacted process status.'});
      if (codex.hasActive(input.id) && ['spawn', 'write', 'remove'].includes(input.action)) return reply(res, 409, { error: 'Codex is working in this sandbox. Read its status or cancel it before issuing other commands.' });
      if (input.action === 'ensure' && (runner.stopping || !(await health()).ready)) return reply(res, 503, { error: 'Worker is unavailable or draining' });
      return reply(res, 200, await sandboxes.rpc(input));
    }
    if (url.pathname === '/codex' && req.method === 'POST') {
      const input = await readJson(req, 160000);
      if (input.action === 'start' && runner.stopping) return reply(res, 503, { error: 'Worker is draining' });
      return reply(res, 200, await codex.rpc(input));
    }
    if (url.pathname === '/sandbox-control' && req.method === 'POST') {
      const input = await readJson(req), s = sandboxes.sessions.get(input.id);
      if (!s || s.workspaceId !== input.workspaceId || !['stop', 'delete'].includes(input.action)) return reply(res, 404, { error: 'Sandbox not found' });
      return reply(res, 200, await sandboxes.rpc({ ...input, owner: s.owner }));
    }
    if (url.pathname === '/sandboxes' && req.method === 'GET') {
      const workspaceId = url.searchParams.get('workspaceId');
      if (!validId(workspaceId)) return reply(res, 400, { error: 'Invalid workspace' });
      return reply(res, 200, { sessions: [...sandboxes.sessions.values()].filter(s => s.workspaceId === workspaceId && !['expired', 'deleted'].includes(s.status)).map(s => sandboxes.view(s)) });
    }
    if (url.pathname === '/subscriptions' && req.method === 'POST') {
      const { ids, origin } = await readJson(req);
      if (!allowedOrigins().includes(origin)) return reply(res, 403, { error: 'Origin not permitted' });
      return reply(res, 200, issueSubscription(key, ids, origin));
    }
    if (url.pathname === '/jobs' && req.method === 'GET') {
      const ids = (url.searchParams.get('ids') || '').split(',');
      if (ids.length > 30 || ids.some(id => !validId(id))) return reply(res, 400, { error: 'Invalid run IDs' });
      return reply(res, 200, { jobs: ids.map(id => runner.jobs.get(id)).filter(Boolean) });
    }
    if (url.pathname === '/jobs' && req.method === 'POST') {
      if (runner.stopping || !(await health()).ready) return reply(res, 503, { error: 'Worker is unavailable or draining' });
      return reply(res, 200, await runner.submit(await readJson(req)));
    }
    const match = url.pathname.match(/^\/jobs\/([a-f0-9-]{36})(\/cancel)?$/);
    const job = match && runner.jobs.get(match[1]);
    if (!job) return reply(res, 404, { error: 'Run not found' });
    if (req.method === 'POST' && match[2]) await runner.cancel(job.id);
    else if (req.method !== 'GET' || match[2]) return reply(res, 405, { error: 'Method not allowed' });
    return reply(res, 200, job);
  } catch (error) { if (!res.headersSent) reply(res, 400, { error: error.message }); else res.end(); }
});
server.listen(Number(process.env.REPO_RUNNER_PORT || 8090), process.env.REPO_RUNNER_HOST || '100.122.229.15');
server.on('upgrade', (req, socket, head) => previews.upgrade(req, socket, head));
void runner.drain().catch(error => console.error('Queue recovery failed:', error.message));
const callback = setInterval(() => {
  if (callbackConfigured) void codexOutbox.drain([...codex.jobs.values()].filter(job=>job.eventId).map(job=>({id:job.eventId,createdAt:job.updatedAt,result:setupCallbackResult(job)}))).catch(()=>console.error('Codex result delivery pending'));
  if (callbackConfigured) void outbox.drain([...runner.jobs.values()].filter(job => terminal(job.status))).catch(error => console.error('Result delivery failed:', error.message));
}, 1000);
callback.unref();
let reconciling = false;
const reconcile = setInterval(async () => {
  if (reconciling) return;
  reconciling = true;
  try { await previews.tick(); await sandboxes.tick(); } catch (error) { console.error('Worker reconciliation:', error.message); } finally { reconciling = false; }
  // A repository run can take minutes. Never let it delay leases or sandbox output.
  if (!runner.stopping) void runner.drain().catch(error => console.error('Queue reconciliation:', error.message));
}, 1000);
reconcile.unref();
process.on('SIGTERM', async () => {
  runner.stopping = true; clearInterval(callback); clearInterval(reconcile); server.close(); server.closeAllConnections();
  await codex.close();
  await Promise.all([...runner.controllers.keys()].map(id => runner.cancel(id)));
  for (const s of sandboxes.sessions.values()) if (s.status === 'ready') await sandboxes.serial(s.id, () => sandboxes.close(s, 'stopped'));
  await events.flush();
});

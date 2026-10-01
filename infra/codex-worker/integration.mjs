// Explicit VPS smoke test: real subscription model + real isolated sandbox.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { ResourceBudget } from '../execution/budget.mjs';
import { ExecutionStore } from '../execution/store.mjs';
import { environmentInspectionCommand } from './environment-inspection.mjs';
import { CodexWorker } from './worker.mjs';
const { Sandboxes } = await import(process.env.QAA_RUNNER_MODULE || '../repo-runner/sandbox.mjs');
const id = randomUUID(), directory = `/var/lib/qa-codex-smoke-${id}`;
const scope = { id, workspaceId: randomUUID(), owner: 'b'.repeat(64) };
const events = new ExecutionStore(`${directory}/events`);
const sandboxes = new Sandboxes({ directory: `${directory}/sandboxes`, events, budget: new ResourceBudget() });
const worker = new CodexWorker({ directory: `${directory}/jobs`, sandboxes, inspectionCommand: environmentInspectionCommand, allowedUser: 'smoke-test' });
let timer;
try {
  await sandboxes.init(); await worker.init(); await sandboxes.rpc({ ...scope, action: 'ensure' });
  const job = await worker.rpc({ ...scope, userId: 'smoke-test', action: 'start', jobId: randomUUID(), task: 'Inspect the environment with inspect_environment and read the completed output first. Then start a tiny Node HTTP server on 0.0.0.0 port 3107 which responds QAA_CODEX_OK. No external repos, installs or dependencies. Verify HTTP response using node fetch in a second command. Report verified port and response in Swedish. Leave the server running. Do not attempt to read host files.' });
  timer = setInterval(() => { void sandboxes.tick().catch(() => {}); }, 1000);
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline && ['starting', 'running'].includes(worker.jobs.get(job.jobId).status)) await new Promise(resolve => setTimeout(resolve, 1000));
  const result = worker.jobs.get(job.jobId);
  assert.equal(result.status, 'completed', result.message);
  const processId = randomUUID();
  await sandboxes.rpc({ ...scope, action: 'spawn', processId, command: "node -e \"if(require('fs').existsSync('/var/lib/qa-codex/.codex/auth.json')||process.env.CODEX_API_KEY||process.env.OPENAI_API_KEY)process.exit(2);fetch('http://127.0.0.1:3107').then(r=>r.text()).then(t=>{console.log(t);process.exit(t==='QAA_CODEX_OK'?0:3)})\"" });
  let p;
  for (let n = 0; n < 30; n++) { p = await sandboxes.rpc({ ...scope, action: 'process', processId }); if (p.status === 'completed') break; await new Promise(resolve => setTimeout(resolve, 500)); }
  assert.equal(p.exitCode, 0); assert.match(p.stdout, /QAA_CODEX_OK/);
  assert.ok((await events.read(id)).snapshot.codex);
  console.log(JSON.stringify({ passed: true, elapsedMs: Date.now() - (deadline - 150000), processes: result.processes.length, result: result.result }));
} finally {
  clearInterval(timer); await worker.close();
  if (sandboxes.sessions.has(id)) await sandboxes.rpc({ ...scope, action: 'delete' });
  await events.flush(); await rm(directory, { recursive: true, force: true });
}

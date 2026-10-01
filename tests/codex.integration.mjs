// Opt-in: temporary chat in the pilot owner's workspace, real subscription turn,
// isolated app startup, live state and the existing browser preview integration.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
if (process.env.RUN_CODEX_TESTS !== '1') throw new Error('Enable Codex integration tests explicitly');
const userId = process.env.CODEX_PILOT_USER_ID, reference = process.env.CODEX_TEST_THREAD_ID;
assert.ok(userId && reference);
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
const threadId = randomUUID(), sessionKey = `codex-smoke-${randomUUID()}`, jobId = randomUUID();
const base = process.env.APP_URL || 'http://localhost:3000';
const request = async (path, input) => {
  const res = await fetch(`${base}/api/internal/${path}`, { method: 'POST', headers: { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify({ userId, threadId, sessionKey, ...input }), signal: AbortSignal.timeout(60000) });
  const data = await res.json(); assert.equal(res.status, 200, JSON.stringify(data)); return data;
};
const sandbox = input => request('sandbox', { input });
let created = false;
try {
  const rows = await sql.unsafe('insert into pat_threads (id,user_id,title,workspace_id) select $1,user_id,$2,workspace_id from pat_threads where id=$3 and user_id=$4 returning id', [threadId, 'Disposable Codex verification', reference, userId]);
  assert.equal(rows.length, 1); created = true;
  await sandbox({ action: 'ensure' });
  const task = 'Inspect the environment and read the completed result. Start a tiny Node HTTP server bound to 0.0.0.0:3107 with HTML <title>Codex VPS verification</title><h1>QAA_CODEX_OK</h1>. No external repositories or dependencies. Verify HTTP 200 with a separate Node fetch command and report port 3107. Leave server running.';
  const first = await request('codex', { action: 'start', jobId, task });
  assert.equal(first.jobId, jobId);
  assert.equal((await request('codex', { action: 'start', jobId, task })).jobId, jobId);
  let job; const start = Date.now();
  do {
    await new Promise(resolve => setTimeout(resolve, 2000));
    job = await request('codex', { action: 'status', jobId });
  } while (['starting', 'running'].includes(job.status) && Date.now() - start < 150000);
  assert.equal(job.status, 'completed', JSON.stringify(job));
  const state = await sandbox({ action: 'status' });
  assert.equal(state.codex.jobId, jobId); assert.ok(state.processes.length >= 2);
  const preview = await sandbox({ action: 'preview', port: 3107 });
  assert.equal(preview.status, 'ready'); assert.equal(preview.title, 'Codex VPS verification');
  console.log(JSON.stringify({ passed: true, elapsedMs: Date.now() - start, codex: job.status, preview: preview.title }));
} finally {
  if (created) {
    await request('codex', { action: 'cancel', jobId }).catch(() => {});
    try { await sandbox({ action: 'delete' }); }
    finally { await sql.unsafe('delete from pat_threads where id=$1 and user_id=$2', [threadId, userId]); }
  }
  await sql.end();
}

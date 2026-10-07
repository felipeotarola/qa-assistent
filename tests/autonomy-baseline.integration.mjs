// Opt-in natural-language baseline. After submission only SQL observes progress;
// no queue drains, continuation prompts or task mutations rescue the mission.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { Client } from 'eve/client';
import { createServerClient } from '@supabase/ssr';
import { assertIsolatedRoundTrip, readIsolationFixture } from './helpers/autonomy-isolation.mjs';
import { verifyIsolatedAppArtifacts } from './helpers/start-isolated-app.mjs';

if (!process.argv.includes('--execute')) throw new Error('Explicit --execute is required for paid isolated model baseline.');
const fixture = await readIsolationFixture();
const verifiedRuntime = await verifyIsolatedAppArtifacts(fixture, { requireRuntime: true });
const origin = fixture.app?.origin;
assert.equal(origin, 'http://127.0.0.1:58000', 'Only the owned isolated application origin is permitted');
const account = JSON.parse(await readFile('.data/autonomy-isolation/ordinary-user.json', 'utf8'));
const cookies = new Map();
const auth = createServerClient(fixture.auth.url, fixture.auth.anonKey, {
  cookieOptions: { name: 'pat_supabase_auth', path: '/', sameSite: 'lax' },
  cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(c => cookies.set(c.name, c.value)) },
});
const login = await auth.auth.signInWithPassword({ email: account.email, password: account.password });
assert.equal(login.error, null);
assert.equal(login.data.user.id, account.userId);
const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
const sql = postgres(fixture.databaseUrl, { prepare: false, max: 2, connection: { TimeZone: 'UTC' } });
const runId = randomUUID();
const output = resolve('.data/autonomy-isolation', `baseline-${runId}.json`);
const protocol = { version: 1, origin, sourceHash: fixture.app.sourceSha256 ?? 'unrecorded', runtime: fixture.runtimeScope,
  repetitions: 3, observationSeconds: 180, model: 'glm-5.3-flash', reasoning: 'low',
  prompt: 'Testa https://example.com och spara en rapport över vad som fungerar och eventuella problem.',
  mode: 'ordinary account; disconnected client; independent scheduler; SQL-only observation',
  fixture: 'Public example.com as observed at execution time; no release-version or known-defect claim',
  startedAt: new Date().toISOString(), attempts: [], processes: verifiedRuntime,
};
async function persist() { await writeFile(output, JSON.stringify(protocol, null, 2)); }
async function api(path, body) {
  const response = await fetch(origin + path, { method: 'POST', redirect: 'error', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  assert.ok(response.ok, `${path}: ${response.status}`);
  return value;
}
try {
  await mkdir(resolve('.data/autonomy-isolation'), { recursive: true });
  await persist();
  for (let repetition = 1; repetition <= protocol.repetitions; repetition++) {
    const current = await verifyIsolatedAppArtifacts(fixture, { requireRuntime: true });
    assert.deepEqual(current.services, verifiedRuntime.services);
    const workspace = (await api('/api/workspaces', { name: `Autonomy baseline ${runId.slice(0, 8)}-${repetition}` })).workspace;
    const thread = (await api('/api/threads', { workspaceId: workspace.id, title: 'Testa en webbplats' })).thread;
    assertIsolatedRoundTrip({ workspaceId: workspace.id, threadId: thread.id, userId: account.userId }, {
      workspaces: [...await sql`select id,user_id from pat_workspaces where id=${workspace.id}`],
      threads: [...await sql`select id,workspace_id,user_id from pat_threads where id=${thread.id}`],
    });
    const attempt = { repetition, workspaceId: workspace.id, threadId: thread.id, startedAt: new Date().toISOString(), snapshots: [] };
    protocol.attempts.push(attempt); await persist();
    const client = new Client({ host: origin, redirect: 'error', headers: { cookie, 'x-pat-browser-thread': thread.id, 'x-pat-message-id': randomUUID(), 'x-pat-chat-model': protocol.model, 'x-pat-reasoning': protocol.reasoning } });
    let session;
    try {
      const submitted = await client.sessions.create({ message: protocol.prompt });
      session = submitted.session;
      attempt.sessionId = session.state.sessionId;
      attempt.acceptedAt = new Date().toISOString();
      // Do not call response.result() or subscribe to the session stream.
      const deadline = Date.now() + protocol.observationSeconds * 1000;
      while (Date.now() < deadline) {
        const [missions, browserJobs, runs, reports, events] = await Promise.all([
          sql`select id,status,revision from pat_missions where workspace_id=${workspace.id} and runtime=${fixture.runtimeScope}`,
          sql`select id,status from pat_browser_jobs where thread_id=${thread.id} and runtime=${fixture.runtimeScope}`,
          sql`select id,result->>'outcome' as outcome from pat_test_runs where workspace_id=${workspace.id}`,
          sql`select r.id,r.status,r.item_id,r.attempts,r.usage from pat_mission_reports r join pat_missions m on m.id=r.mission_id where m.workspace_id=${workspace.id}`,
          sql`select event from pat_chat_events where thread_id=${thread.id} and event->>'type' in ('turn.completed','turn.failed','turn.cancelled','step.completed','actions.requested') order by emitted_at`,
        ]);
        const actions = events.flatMap(({ event }) => event.type === 'actions.requested' ? event.data.actions.map(a => a.toolName ?? a.kind) : []);
        const steps = events.filter(({ event }) => event.type === 'step.completed');
        const snapshot = { at: new Date().toISOString(), missions, browserJobs, runs, reports, toolNames: actions,
          usage: { inputTokens: steps.reduce((sum, { event }) => sum + (event.data.usage?.inputTokens ?? 0), 0), outputTokens: steps.reduce((sum, { event }) => sum + (event.data.usage?.outputTokens ?? 0), 0), known: steps.length > 0 && steps.every(({ event }) => Number.isFinite(event.data.usage?.inputTokens) && Number.isFinite(event.data.usage?.outputTokens)), cost: null },
          endedTurns: events.filter(({ event }) => ['turn.completed','turn.failed','turn.cancelled'].includes(event.type)).map(({ event }) => event.type) };
        const previous = attempt.snapshots.at(-1);
        if (JSON.stringify({ ...previous, at: '' }) !== JSON.stringify({ ...snapshot, at: '' })) { attempt.snapshots.push(snapshot); await persist(); }
        if (missions.length && missions.every(m => m.status === 'closed') && reports.some(r => r.status === 'completed')) {
          attempt.terminalBeforeClientReopen = true; break;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      const last = attempt.snapshots.at(-1);
      attempt.result = attempt.terminalBeforeClientReopen && last.runs.length ? 'completed QA chain' : 'acceptance not reached within fixed observation window';
    } catch (error) {
      attempt.result = 'failed'; attempt.errorType = error instanceof Error ? error.name : 'unknown';
    } finally {
      attempt.finishedAt = new Date().toISOString(); await persist();
      // Cleanup occurs strictly after the observation verdict, never to progress work.
      if (session) await session.cancel().catch(() => {});
      const workers = await sql`select id from pat_browser_jobs where thread_id=${thread.id} and status in ('starting','running','dispatch_unknown')`;
      for (const worker of workers) await api(`/api/workspaces/${workspace.id}/browser-jobs`, { action: 'cancel', threadId: thread.id, jobId: worker.id }).catch(() => {});
      console.log(JSON.stringify({ baseline: runId, repetition, result: attempt.result, artifact: output }));
    }
  }
} finally { await sql.end(); }

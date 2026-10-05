import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { Client } from 'eve/client';

// Uses the isolated account from mission-reports.integration.mjs, never a user's workspace.
if (process.env.RUN_MISSION_REPORT_TESTS !== '1') throw new Error('Set RUN_MISSION_REPORT_TESTS=1 and create a retained disposable fixture first.');
const fixture = JSON.parse(await readFile('.data/mission-fixture.json', 'utf8'));
const origin = 'http://localhost:3000', title = `Klara live orchestration ${randomUUID()}`;
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
let session;
try {
  const response = await fetch(`${origin}/api/threads`, { method: 'POST', headers: { cookie: fixture.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ title, workspaceId: fixture.workspaceId }) });
  assert.equal(response.status, 201);
  const { thread } = await response.json();
  const eve = new Client({ host: origin, headers: { cookie: fixture.cookie, 'x-pat-browser-thread': thread.id, 'x-pat-chat-model': 'glm-5.3-flash', 'x-pat-reasoning': 'low' } });
  const turn = await eve.sessions.create({ message: `Detta är ett avgränsat integrationstest. Skapa ett NYTT uppdrag med mission-verktyget, titel "${title}", mål att dokumentera vad https://example.com säger. Ett kriterium: beskriv sidans syfte med sparat källunderlag. Inga testfall eller repojobb ingår. Registrera en deluppgift för research och läs example.com med research-verktyget; skicka uppdragets missionId och taskId. Be sedan Klara skriva rapporten med mission report och avsluta din tur. Använd inte den interaktiva browsern, starta inga tester och ändra inga befintliga uppdrag. Rapportera endast verifierade sparanden.` });
  session = turn.session;
  assert.equal((await turn.response.result()).status, 'waiting');
  const [mission] = await sql`select * from pat_missions where workspace_id=${fixture.workspaceId} and config->>'title'=${title}`;
  assert.ok(mission, 'V must create the mission through its real tool');
  const tasks = await sql`select * from pat_mission_tasks where mission_id=${mission.id}`;
  assert.ok(tasks.some(t => t.sources.some(s => s.type === 'research')), 'Research must persist a source bound to the mission');
  const events = [];
  for await (const event of eve.sessions.attach(session.state.sessionId).stream({ follow: false })) events.push(event);
  const research = events.flatMap(e => e.type === 'actions.requested' ? e.data.actions : []).find(a => a.toolName === 'research');
  const binding = typeof research?.input.mission === 'string' ? JSON.parse(research.input.mission) : research?.input.mission;
  assert.equal(binding?.missionId, mission.id, 'Binding must accompany the research call, not only be attached afterwards');
  let report;
  for (let i = 0; i < 100; i++) {
    [report] = await sql`select * from pat_mission_reports where mission_id=${mission.id} order by created_at desc limit 1`;
    if (report?.status === 'completed' || report?.status === 'failed') break;
    if (i % 20 === 0) await fetch(`${origin}/api/internal/mission-reports/drain`, { method: 'POST', headers: { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}`, 'content-type': 'application/json' }, body: '{}' });
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  assert.equal(report?.status, 'completed'); assert.equal(report.document.tests.length, 0); assert.ok(report.read_receipts.length > 0);
  await fetch(`${origin}/api/internal/mission-reports/drain`, { method: 'POST', headers: { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}`, 'content-type': 'application/json' }, body: '{}' });
  let updated = [];
  for (let i = 0; i < 40; i++) {
    updated = []; for await (const event of eve.sessions.attach(session.state.sessionId).stream({ follow: false })) updated.push(event);
    if (updated.filter(e => e.type === 'turn.completed').length >= 2) break;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  assert.ok(updated.filter(e => e.type === 'turn.completed').length >= 2, 'V must finish its report notification');
  assert.ok(JSON.stringify(updated).includes(`/reports/${report.id}?workspace=${fixture.workspaceId}`));
  assert.equal(updated.filter(e => e.type === 'action.result' && e.data.sequence > 0).length, 0, 'Notification must not start more work');
  console.log('PASS real V -> mission/task -> research binding -> Klara evidence reads -> Material -> brief tool-free notification');
} finally {
  if (session) await session.cancel().catch(() => {});
  await sql.end();
}

// Actual isolated HTTP/auth/DB verification after a saved autonomous report.
// No model, scheduler drain, source mutation, or shared-service configuration.
import assert from 'node:assert/strict';
import { randomInt, randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import postgres from 'postgres';
import { createServerClient } from '@supabase/ssr';
import { readIsolationFixture, isolatedProcessEnvironment } from './helpers/autonomy-isolation.mjs';
import { verifyIsolatedAppArtifacts } from './helpers/start-isolated-app.mjs';

assert.ok(process.argv.includes('--execute'), 'Explicit isolated share-mutation test required');
const option = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const workspaceId = option('workspace'), reportId = option('report');
for (const id of [workspaceId, reportId]) assert.match(id ?? '', /^[a-f0-9-]{36}$/);
const fixture = await readIsolationFixture(); isolatedProcessEnvironment(fixture);
assert.equal(fixture.app.origin, 'http://127.0.0.1:58000');
const verified = await verifyIsolatedAppArtifacts(fixture, { requireRuntime: true });
const root = resolve('.data/autonomy-isolation'), accountPath = resolve(option('account') ?? '.data/autonomy-isolation/ordinary-user.json');
const actual = await realpath(accountPath), sub = relative(root, actual);
assert.ok(sub && sub !== '..' && !sub.startsWith(`..${sep}`) && !isAbsolute(sub) && actual === accountPath);
const account = JSON.parse(await readFile(actual));
const sql = postgres(fixture.databaseUrl, { prepare: false, max: 1, connection: { default_transaction_read_only: 'on', TimeZone: 'UTC' } });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const htmlContains = (html, value) => {
  const escaped = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  return [value, escaped, JSON.stringify(value).slice(1, -1)].some(text => html.includes(text));
};
const artifact = { protocol: 'syna-autonomy-sharing-v2', sourceHash: verified.sourceSha256, workspaceId, reportId,
  startedAt: new Date().toISOString(), checks: [], actions: [], result: 'running', actualModelCalls: 0,
  scope: 'Actual isolated auth, HTTP, SSR and saved report sharing. Not a new QA execution or quality/prose approval.' };
const output = resolve(root, `sharing-acceptance-${randomUUID()}.json`);
const persist = () => writeFile(output, JSON.stringify(artifact, null, 2));
function publicProjection(document) {
  const keys = (value, allowed) => assert.deepEqual(Object.keys(value).sort(), allowed.split(' ').sort(), 'Public field allowlist changed');
  keys(document, 'schemaVersion title capturedAt revision goal scope target partial summary limitations criteria findings metrics tasks tests evidence');
  for (const value of document.criteria) keys(value, 'id text');
  for (const value of document.findings) {
    keys(value, 'criterionId verdict conclusion evidenceIds nextStep' + (Object.hasOwn(value, 'completionStatement') ? ' completionStatement' : '') + (Object.hasOwn(value, 'observations') ? ' observations' : ''));
    if (Object.hasOwn(value, 'completionStatement')) assert.equal(typeof value.completionStatement, 'string');
    if (Object.hasOwn(value, 'observations')) {
      assert.ok(Array.isArray(value.observations));
      for (const observation of value.observations) {
        keys(observation, 'text evidenceIds originLabel' + (observation.subject ? ' subject' : '') + (observation.savedReview ? ' savedReview' : ''));
        if (observation.subject) keys(observation.subject, 'requirement relation');
        if (observation.savedReview) {
          keys(observation.savedReview, 'version reportedStatus reportedActual reviewerVersion finding');
          keys(observation.savedReview.finding, 'verdict explanation suggestedNextStep gap');
          if (observation.savedReview.finding.gap) keys(observation.savedReview.finding.gap, 'kind capability wantedEvidence');
        }
        assert.ok(typeof observation.text === 'string' && observation.text.length && typeof observation.originLabel === 'string' && observation.originLabel.length);
        assert.ok(Array.isArray(observation.evidenceIds) && observation.evidenceIds.length);
        assert.ok(observation.evidenceIds.every(id => value.evidenceIds.includes(id) && document.evidence.some(evidence => evidence.id === id)), 'Observation citation is outside public report evidence');
      }
    }
  }
  for (const value of document.tasks) keys(value, 'id title actor parentId dependsOn status reportedOutcome startedAt finishedAt');
  for (const value of document.tests) { keys(value, 'key title status runId review target originalOutcome manualReview'); assert.equal(value.runId, null); }
  for (const value of document.evidence) { keys(value, 'id title itemId version kind url observedAt read'); assert.equal(value.itemId, null); }
  for (const value of document.metrics) { keys(value, 'id label data'); for (const point of value.data) keys(point, 'label value'); }
}
let cookie = '', cleanupNeeded = false;
async function request(path, { method = 'GET', body, access = '', expected = 200 } = {}) {
  assert.ok(path.startsWith('/') && !path.startsWith('//'));
  const response = await fetch(fixture.app.origin + path, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { ...(access ? { cookie: access } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal(response.status, expected, `Unexpected HTTP status at ${path.split('?')[0].replace(/report-shares\/[^/]+/, 'report-shares/[token]')}`);
  return response;
}
const reportPath = `/api/workspaces/${workspaceId}/reports/${reportId}`;
async function change(body) {
  artifact.actions.push({ action: body.action, ...(body.mode ? { mode: body.mode } : {}), startedAt: new Date().toISOString() });
  await persist();
  const response = await request(`${reportPath}/share`, { method: 'POST', body, access: cookie });
  const result = await response.json(); artifact.actions.at(-1).completedAt = new Date().toISOString(); await persist(); return result;
}
async function originalHash() {
  const rows = await sql`select r.*,s.input as original_snapshot from pat_mission_reports r join pat_mission_snapshots s on s.id=r.snapshot_id join pat_missions m on m.id=r.mission_id where r.id=${reportId} and m.workspace_id=${workspaceId} and m.user_id=${account.userId} and m.runtime=${fixture.runtimeScope}`;
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'completed'); assert.ok(rows[0].document);
  return hash(JSON.stringify(rows));
}
try {
  artifact.originalSha256 = await originalHash();
  const cookies = new Map(), auth = createServerClient(fixture.auth.url, fixture.auth.anonKey, { cookieOptions: { name: 'pat_supabase_auth', path: '/', sameSite: 'lax' }, cookies: {
    getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(v => cookies.set(v.name, v.value)),
  } });
  const login = await auth.auth.signInWithPassword({ email: account.email, password: account.password }); assert.equal(login.error, null); assert.equal(login.data.user.id, account.userId); assert.equal(login.data.user.role, 'authenticated');
  cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  assert.equal((await (await request(`${reportPath}/share`, { access: cookie })).json()).share, null, 'Do not replace an existing share');
  const existing = await sql`select sh.id from pat_report_shares sh join pat_mission_reports r on r.id=sh.report_id where r.mission_id=(select mission_id from pat_mission_reports where id=${reportId}) and sh.revoked_at is null`;
  assert.equal(existing.length, 0, 'Do not revoke existing shares of any version of this mission');
  const report = await (await request(reportPath, { access: cookie })).json();
  const image = report.document.evidence.find(e => e.kind === 'image' && e.itemId);
  const included = image ? [image.id] : [];
  let ownedAsset;
  if (image) {
    const [item] = await sql`select version,content,provenance from pat_workspace_items where id=${image.itemId} and workspace_id=${workspaceId} and deleted_at is null`;
    assert.equal(item?.version, image.version); assert.match(item?.provenance?.sha256 ?? '', /^[a-f0-9]{64}$/);
    const response = await request(`${reportPath}/asset?evidenceId=${encodeURIComponent(image.id)}`, { access: cookie });
    const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(hash(bytes), item.provenance.sha256);
    assert.equal(response.headers.get('content-type'), item.content.mime);
    ownedAsset = { bytes: bytes.length, sha256: hash(bytes), mime: item.content.mime };
  }
  async function assertAsset(path, access = '') {
    const response = await request(path, { access }); const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.headers.get('content-type'), ownedAsset.mime); assert.equal(bytes.length, ownedAsset.bytes); assert.equal(hash(bytes), ownedAsset.sha256);
  }
  const pin = String(randomInt(100000, 900000)), wrong = String(Number(pin) + 1);
  cleanupNeeded = true;
  const created = await change({ action: 'create', mode: 'pin', pin, evidenceIds: included, expiresAt: null });
  const token = created.share.path.split('/').at(-1), publicPath = `/api/report-shares/${token}`;
  const locked = await request(publicPath); assert.deepEqual(await locked.json(), { locked: true }); assert.match(locked.headers.get('cache-control'), /no-store/);
  const page = await request(created.share.path), lockedHtml = await page.text();
  assert.ok(lockedHtml.includes('Privat rapport'), 'PIN SSR must render the locked report form');
  for (const content of [report.document.title, report.document.summary]) assert.ok(!htmlContains(lockedHtml, content), 'PIN SSR must not disclose saved report content');
  assert.match(page.headers.get('cache-control'), /no-store/);
  if (image) await request(`${publicPath}/asset?evidenceId=${encodeURIComponent(image.id)}`, { expected: 401 });
  await request(`${publicPath}/unlock`, { method: 'POST', body: { pin: wrong }, expected: 401 });
  const unlocked = await request(`${publicPath}/unlock`, { method: 'POST', body: { pin } }); await unlocked.body?.cancel();
  const setCookie = unlocked.headers.get('set-cookie'); assert.match(setCookie, /HttpOnly/i); assert.match(setCookie, /SameSite=Lax/i);
  const access = setCookie.split(';')[0], shared = await (await request(publicPath, { access })).json();
  assert.equal(shared.locked, false); assert.equal(shared.document.title, report.document.title);
  publicProjection(shared.document);
  assert.deepEqual(shared.assets.map(e => e.id), included);
  if (image) {
    await assertAsset(shared.assets[0].url, access); artifact.asset = ownedAsset;
  }
  await request(`${publicPath}/asset?evidenceId=item:unselected`, { access, expected: 404 });
  artifact.checks.push('PIN, anonymous locked SSR, private-cookie access and explicit attachment allowlist');
  await change({ action: 'change_pin', pin: wrong });
  assert.deepEqual(await (await request(publicPath, { access })).json(), { locked: true });
  if (image) await request(shared.assets[0].url, { access, expected: 401 });
  const publicShare = await change({ action: 'create', mode: 'public', evidenceIds: included, expiresAt: null });
  await request(publicPath, { expected: 404 });
  const publicApi = `/api/report-shares/${publicShare.share.path.split('/').at(-1)}`;
  const anonymous = await (await request(publicApi)).json(); assert.equal(anonymous.document.title, report.document.title); publicProjection(anonymous.document);
  assert.deepEqual(anonymous.document, shared.document);
  if (image) await assertAsset(anonymous.assets[0].url);
  const publicHtml = await (await request(publicShare.share.path)).text();
  for (const content of [anonymous.document.title, anonymous.document.summary]) assert.ok(htmlContains(publicHtml, content), 'Anonymous SSR omitted saved report content');
  artifact.checks.push('PIN rotation revokes old sessions; public mode revokes old link and supports anonymous HTTP/SSR');
  await change({ action: 'revoke' }); cleanupNeeded = false;
  await request(publicApi, { expected: 404 });
  assert.equal(await originalHash(), artifact.originalSha256);
  artifact.checks.push('Final share revoked; original report and snapshot unchanged');
  artifact.imageScope = image ? 'Selected real saved image served' : 'No image in selected report; pixel serving not tested';
  artifact.result = 'passed';
} catch (error) {
  artifact.result = 'failed'; artifact.error = { name: error.name, code: error.code ?? null };
  process.exitCode = 1;
} finally {
  if (cleanupNeeded && cookie) {
    try { await change({ action: 'revoke' }); artifact.cleanup = 'revoked'; }
    catch { artifact.cleanup = 'unknown; inspect exact report share before further mutation'; }
  }
  await sql.end(); artifact.finishedAt = new Date().toISOString(); await persist();
  console.log(JSON.stringify({ result: artifact.result, output, checks: artifact.checks.length, cleanup: artifact.cleanup ?? 'not needed' }));
}

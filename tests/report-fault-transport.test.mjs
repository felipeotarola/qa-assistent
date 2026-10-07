import { test } from 'node:test';
import { REVIEW_MODEL } from '../shared/result-assessment.ts';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { ReportCommitBoundary, PgFrames, createReportPgFaultProxy } from './helpers/report-fault-pg.mjs';
import { reportProviderIdentity, reportBarrierFetch } from './helpers/report-fault-provider.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const zero = value => Buffer.from(`${value}\0`);
function i16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; }
function i32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }
function frame(type, bytes) { return Buffer.concat([Buffer.from(type), i32(bytes.length + 4), bytes]); }
const query = sql => frame('Q', zero(sql));
const complete = command => frame('C', zero(command));
const ready = state => frame('Z', Buffer.from(state));
function insert(ids = ['report', 'mission', 'snapshot'], portal = '') {
  const sql = 'insert into "pat_mission_reports" ("id", "mission_id", "snapshot_id", "document") values ($1, $2, $3, $4) returning "id"';
  const parameters = [...ids, 'SECRET_DOCUMENT_NOT_IN_RECEIPT'];
  return [frame('P', Buffer.concat([zero(portal), zero(sql), i16(0)])),
    frame('B', Buffer.concat([zero(portal), zero(portal), i16(0), i16(parameters.length), ...parameters.flatMap(value => [i32(Buffer.byteLength(value)), Buffer.from(value)]), i16(0)])),
    frame('E', Buffer.concat([zero(portal), i32(0)]))];
}
function transaction(b, ids) { b.client(query('begin')); b.server(complete('BEGIN')); for (const f of insert(ids)) b.client(f); b.server(complete('INSERT 0 1')); b.client(query('commit')); return b.server(complete('COMMIT')); }
const startup = database => { const body = Buffer.concat([i32(196608), zero('user'), zero('fixture'), zero('database'), zero(database), Buffer.from([0])]); return Buffer.concat([i32(body.length + 4), body]); };

test('PG receipt requires successful INSERT followed by its own COMMIT, retaining only exact identities', () => {
  assert.deepEqual(transaction(new ReportCommitBoundary()), { reportId: 'report', missionId: 'mission', snapshotId: 'snapshot' });
  const b = new ReportCommitBoundary(); b.client(query('begin')); b.server(complete('BEGIN'));
  for (const f of insert()) b.client(f); b.server(complete('INSERT 0 1')); b.client(query('rollback'));
  assert.equal(b.server(complete('ROLLBACK')), null);
  assert.equal(JSON.stringify(transaction(new ReportCommitBoundary())).includes('SECRET'), false);
});
test('PG pipeline cannot bind an earlier commit to a later report INSERT', () => {
  const b = new ReportCommitBoundary();
  b.client(query('begin')); b.client(query('commit')); b.client(query('begin')); for (const f of insert()) b.client(f); b.client(query('commit'));
  b.server(complete('BEGIN')); assert.equal(b.server(complete('COMMIT')), null); b.server(complete('BEGIN')); b.server(complete('INSERT 0 1'));
  assert.deepEqual(b.server(complete('COMMIT')), { reportId: 'report', missionId: 'mission', snapshotId: 'snapshot' });
});
test('PG error, duplicate queue insertion and literal/multi-query identities never certify a fault', () => {
  for (const kind of ['error', 'duplicate', 'literal', 'multi']) {
    const b = new ReportCommitBoundary(); b.client(query('begin')); b.server(complete('BEGIN'));
    if (kind === 'literal') b.client(query("insert into pat_mission_reports(id,mission_id,snapshot_id) values ('a','b','c')"));
    else { for (const f of insert()) b.client(f); b.server(complete('INSERT 0 1')); }
    if (kind === 'duplicate') { for (const f of insert(['r2', 'mission', 's2'])) b.client(f); b.server(complete('INSERT 0 1')); }
    if (kind === 'error') b.server(frame('E', zero('ERROR')));
    if (kind === 'multi') b.client(query('select 1; select 2'));
    b.client(query('commit')); assert.equal(b.server(complete('COMMIT')), null, kind);
  }
});
test('PG frames support split/coalesced messages and refuse TLS/oversize before forwarding', () => {
  const data = Buffer.concat([startup('syna_test_autonomy_transport'), query('begin'), query('commit')]), p = new PgFrames(true), frames = [];
  for (let i = 0; i < data.length; i += 3) frames.push(...p.push(data.subarray(i, i + 3)));
  assert.equal(frames.length, 3); assert.deepEqual(Buffer.concat(frames.map(f => f.bytes)), data);
  assert.throws(() => new PgFrames(true).push(Buffer.concat([i32(8), i32(80877103)])), /unencrypted/);
  assert.throws(() => new PgFrames().push(Buffer.concat([Buffer.from('Q'), i32(20 * 1024 * 1024)])), /excessive/);
});

test('actual loopback PG transport loses only a verified committed ACK, never the committed work', async () => {
  for (const drop of [true, false]) {
    let committed = false, received = '', verified = 0, receipt; const sockets = new Set();
    const backend = createServer(socket => { sockets.add(socket); const parser = new PgFrames(true); socket.on('close', () => sockets.delete(socket)); socket.on('data', bytes => {
      for (const value of parser.push(bytes)) {
        if (value.startup) { socket.write(ready('I')); continue; }
        const f = value.bytes, type = String.fromCharCode(f[0]);
        if (type === 'Q') { const q = f.subarray(5).toString(); if (q.startsWith('begin')) socket.write(complete('BEGIN')); else if (q.startsWith('commit')) { committed = true; socket.write(Buffer.concat([complete('COMMIT'), ready('I')])); } }
        if (type === 'E') socket.write(complete('INSERT 0 1'));
      }
    }); });
    backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
    const proxy = createReportPgFaultProxy({ upstreamPort: backend.address().port, database: 'syna_test_autonomy_transport', verifyCommitted: async candidate => {
      verified++; assert.equal(committed, true); assert.equal(candidate.reportId, 'report'); return drop;
    }, onDropped: value => { receipt = value; } });
    proxy.server.listen(0, '127.0.0.1'); await once(proxy.server, 'listening');
    const client = connect(proxy.server.address().port, '127.0.0.1'); client.on('error', () => {}); client.on('data', bytes => { received += bytes.toString(); });
    try {
      await once(client, 'connect'); client.write(Buffer.concat([startup('syna_test_autonomy_transport'), query('begin'), ...insert(), query('commit')]));
      const deadline = Date.now() + 2000; while (!(drop ? receipt : received.includes('COMMIT')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(verified, 1); assert.equal(committed, true); assert.equal(received.includes('COMMIT'), !drop); assert.equal(!!receipt, drop);
      if (receipt) assert.deepEqual(Object.keys(receipt).sort(), ['connectionId', 'droppedAt', 'missionId', 'reportId', 'snapshotId']);
    } finally { client.destroy(); await proxy.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => backend.close(resolve)); }
  }
});

const body = () => JSON.stringify({ model: REVIEW_MODEL, response_format: { json_schema: { schema: {} } }, messages: [{ role: 'user', content: [
  { type: 'text', text: JSON.stringify({ schemaVersion: 2, missionId: 'mission', workspaceId: 'workspace', revision: 1, inputFingerprint: 'a'.repeat(64), evidenceSelection: { basis: 'metadata_selection_only', readEvidenceIds: ['item:one'] } }) },
  { type: 'text', text: JSON.stringify({ id: 'item:one', digest: hash('actual source'), text: 'actual source' }) },
] }] });
const responseText = JSON.stringify({ choices: [{ message: { content: '{"summary":"actual synthetic provider output"}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
test('provider selector requires full actual attachments and exports no raw source or prompt', () => {
  const receipt = reportProviderIdentity(body()); assert.equal(receipt.missionId, 'mission'); assert.equal(JSON.stringify(receipt).includes('actual source'), false);
  const oldModel = JSON.parse(body()); oldModel.model = 'glm-5.3-flash'; assert.equal(reportProviderIdentity(JSON.stringify(oldModel)), null);
  const value = JSON.parse(body()); value.messages[0].content.pop(); assert.equal(reportProviderIdentity(JSON.stringify(value)), null);
  const image = JSON.parse(body()), bytes = Buffer.from('actual png fixture');
  image.messages[0].content[1].text = JSON.stringify({ id: 'item:one', digest: hash(bytes), image: 'Pixels follow' });
  assert.equal(reportProviderIdentity(JSON.stringify(image)), null);
  image.messages[0].content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` } });
  assert.ok(reportProviderIdentity(JSON.stringify(image))); image.messages[0].content[2].image_url.url += 'A'; assert.equal(reportProviderIdentity(JSON.stringify(image)), null);
});
test('provider barrier releases the identical successful bytes after the owner-write receipt, one physical request only', async () => {
  const order = []; let physical = 0;
  const fetch = reportBarrierFetch(async () => { physical++; order.push('provider completed'); return new Response(responseText, { headers: { 'content-type': 'application/json' } }); }, {
    match: async identity => identity.missionId === 'mission', afterResponse: async held => { order.push('ordinary owner PATCH'); assert.equal(held.providerResponseSha256, hash(responseText)); return { released: true, requestSha256: held.requestSha256 }; },
  });
  const response = await fetch('https://api.grunden.ai/v1/chat/completions', { method: 'POST', body: body() }); order.push('SDK received response');
  assert.equal(await response.text(), responseText); assert.equal(physical, 1); assert.deepEqual(order, ['provider completed', 'ordinary owner PATCH', 'SDK received response']);
});
test('scope mismatch, other requests and 429 responses never inject a freshness fault', async () => {
  let hooks = 0, physical = 0;
  const fetch = reportBarrierFetch(async () => { physical++; return new Response('rate limited', { status: 429 }); }, { match: async () => true, afterResponse: async () => { hooks++; } });
  for (const request of [{ url: 'https://api.grunden.ai/v1/chat/completions', body: body() }, { url: 'https://example.test', body: body() }, { url: 'https://api.grunden.ai/v1/chat/completions', body: '{}' }]) assert.equal((await fetch(request.url, { method: 'POST', body: request.body })).status, 429);
  assert.equal(hooks, 0); assert.equal(physical, 3);
});
test('provider response timeout or wrong release cannot retry or substitute a model answer', async () => {
  for (const callback of [async () => ({ released: true, requestSha256: 'wrong' }), async () => new Promise(() => {})]) {
    let physical = 0; const fetch = reportBarrierFetch(async () => { physical++; return new Response(responseText, { headers: { 'content-type': 'application/json' } }); }, { match: async () => true, afterResponse: callback, maxHoldMs: 10 });
    await assert.rejects(fetch('https://api.grunden.ai/v1/chat/completions', { method: 'POST', body: body() })); assert.equal(physical, 1);
  }
});

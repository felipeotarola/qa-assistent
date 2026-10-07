// Opt-in only. Never starts the application, scheduler, provider or a mission.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { createServerClient } from '@supabase/ssr';
import { loadReportFaultConfig, reportFaultPrivateFile, reportFaultAuthorized, reportFaultController, appendReportFaultReceipt } from './report-fault-control.mjs';
import { createReportPgFaultProxy } from './report-fault-pg.mjs';
import { utcObservationTypes } from './utc-postgres-observation.mjs';
import { reportFaultRuntimeFiles } from './report-fault-runtime.mjs';

export async function startReportFaultDriver(configFile) {
  const { config, fixture, manifest, upstream, receiptPath } = await loadReportFaultConfig(configFile);
  const sql = postgres(config.upstreamDatabaseUrl, { prepare: false, max: 2, types: utcObservationTypes,
    connection: { TimeZone: 'UTC', default_transaction_read_only: 'on', statement_timeout: 2000 } });
  const metadata = { protocol: manifest.protocol, taskId: manifest.taskId, variant: manifest.variant, manifestSha256: config.manifestSha256, sourceHash: manifest.sourceHash, runtime: manifest.runtime };
  let proxy, server, preloadReady = null;
  try {
    assert.equal((await sql`select current_database() as name`)[0].name, upstream.pathname.slice(1));
    assert.equal((await sql`show transaction_read_only`)[0].transaction_read_only, 'on');
    await writeFile(receiptPath, JSON.stringify({ ...metadata, state: 'driver_ready', deadlineAt: config.deadlineAt, startedAt: new Date().toISOString() }) + '\n', { flag: 'wx' });
    const controller = reportFaultController({ manifest, deadlineAt: config.deadlineAt, journal: appendReportFaultReceipt(receiptPath, metadata),
      async verifyArm(trial, threadId) {
        const account = JSON.parse(await reportFaultPrivateFile(trial.accountFile));
        const rows = await sql`select w.user_id from pat_workspaces w join pat_threads t on t.workspace_id=w.id where w.id=${trial.workspaceId} and t.id=${threadId} and t.user_id=w.user_id`;
        assert.equal(rows.length, 1); assert.equal(rows[0].user_id, account.userId);
        assert.equal((await sql`select id from pat_missions where thread_id=${threadId}`).length, 0, 'Arm before natural intake, never after observing an outcome');
        const cookies = new Map(), auth = createServerClient(fixture.auth.url, fixture.auth.anonKey, { cookieOptions: { name: 'pat_supabase_auth', path: '/', sameSite: 'lax' }, cookies: {
          getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(c => cookies.set(c.name, c.value)),
        } });
        const result = await auth.auth.signInWithPassword({ email: account.email, password: account.password });
        assert.equal(result.error, null); assert.equal(result.data.user.id, account.userId); assert.equal(result.data.user.role, 'authenticated');
        return { userId: account.userId, cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') };
      },
      async queueIdentity(identity) {
        if (!identity.missionId) return null;
        const rows = await sql`select r.id as "reportId",r.snapshot_id as "snapshotId",m.id as "missionId",m.workspace_id as "workspaceId",m.thread_id as "threadId",m.user_id as "userId",a.id as "attemptId",s.input->>'inputFingerprint' as "inputFingerprint"
          from pat_mission_reports r join pat_missions m on m.id=r.mission_id join pat_mission_snapshots s on s.id=r.snapshot_id
          join pat_mission_attempts a on a.mission_id=m.id and a.executor_resource_id=r.id and a.kind='report'
          where m.id=${identity.missionId} and m.runtime=${manifest.runtime} and m.controller_version=1 and m.intent='report_only'
            and m.lifecycle in ('running','cancelling') and a.runtime=m.runtime and a.mandate_revision=m.mandate_revision and a.plan_revision=m.plan_revision
            and a.status in ('dispatching','dispatch_unknown','running') and a.deadline_at>clock_timestamp()
            and r.status in ('queued','running') and r.document is null and r.item_id is null
            and (${identity.reportId ?? null}::text is null or r.id=${identity.reportId ?? null})
            and (${identity.snapshotId ?? null}::text is null or s.id=${identity.snapshotId ?? null})`;
        if (rows.length !== 1) return null;
        const row = rows[0];
        if (identity.workspaceId && row.workspaceId !== identity.workspaceId || identity.inputFingerprint && row.inputFingerprint !== identity.inputFingerprint) return null;
        return row;
      },
      async currentItem(workspaceId, itemId) { const rows = await sql`select id,title,version,content,provenance from pat_workspace_items where id=${itemId} and workspace_id=${workspaceId} and deleted_at is null`; assert.equal(rows.length, 1); return rows[0]; },
      async patchItem(state, item, text, signal) {
        const response = await fetch(`${config.appOrigin}/api/workspaces/${state.workspaceId}/items/${item.id}`, { method: 'PATCH',
          headers: { cookie: state.cookie, 'content-type': 'application/json' }, redirect: 'error', signal,
          body: JSON.stringify({ expectedVersion: item.version, title: item.title, content: { kind: 'text', text } }) });
        assert.equal(response.status, 200, 'Ordinary owner update did not return a verified receipt');
        return (await response.json()).item;
      },
    });
    server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
      if (!reportFaultAuthorized(req.headers.authorization, config.controlKey)) { res.writeHead(401).end('{}'); return; }
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (req.method === 'GET' && url.pathname === '/ready') { res.end(JSON.stringify({ ...metadata, deadlineAt: config.deadlineAt, pgPort: config.pgPort ?? null, expired: Date.now() >= Date.parse(config.deadlineAt), preloadReady })); return; }
        if (req.method === 'GET' && url.pathname === '/receipt') { res.end(JSON.stringify(controller.receipt(url.searchParams.get('workspaceId')))); return; }
        assert.equal(req.method, 'POST'); assert.ok(['/arm', '/provider/match', '/provider/response', '/preload-ready'].includes(url.pathname));
        const chunks = []; let bytes = 0; for await (const chunk of req) { bytes += chunk.length; assert.ok(bytes <= 20000); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const abort = new AbortController(); res.on('close', () => abort.abort());
        let output;
        if (url.pathname === '/preload-ready') {
          assert.equal(manifest.taskId, 'REP-06'); assert.ok(Date.now() < Date.parse(config.deadlineAt));
          assert.equal(body.runtime, manifest.runtime); assert.equal(body.sourceHash, manifest.sourceHash); assert.equal(body.manifestSha256, config.manifestSha256);
          assert.ok(Number.isSafeInteger(body.pid) && body.pid > 0); assert.match(body.nonce, /^[a-f0-9]{64}$/);
          assert.deepEqual(body.helperHashes, Object.fromEntries(reportFaultRuntimeFiles.map(file => [file, manifest.fault.codeHashes[file]])));
          assert.equal(body.serviceRoot, resolve(fixture.app.root, 'web'));
          preloadReady = { ...body, readyAt: new Date().toISOString() }; output = { ready: true, nonce: body.nonce };
        } else if (url.pathname === '/arm') output = await controller.arm(body);
        else if (url.pathname === '/provider/match') output = { allowed: await controller.matches(body) };
        else output = await controller.response(body, AbortSignal.any([abort.signal, AbortSignal.timeout(manifest.fault.maxHoldMs - 500)]));
        res.end(JSON.stringify(output));
      } catch { if (!res.headersSent) res.writeHead(409); res.end('{"error":"Exact fault binding or boundary was not verified"}'); }
    });
    server.requestTimeout = 12000; server.headersTimeout = 5000;
    server.listen(config.controlPort, '127.0.0.1'); await once(server, 'listening');
    if (manifest.taskId === 'REP-05') {
      proxy = createReportPgFaultProxy({ upstreamPort: Number(upstream.port), database: upstream.pathname.slice(1), verifyCommitted: controller.commit, onDropped: controller.dropped });
      proxy.server.listen(config.pgPort, '127.0.0.1'); await once(proxy.server, 'listening');
    }
    return { ready: { ...metadata, pgPort: config.pgPort ?? null, controlPort: config.controlPort }, async close() {
      if (proxy) await proxy.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await sql.end();
    } };
  } catch (error) { if (proxy) await proxy.close(); if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await sql.end(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.argv.includes('--serve'), 'Explicit --serve is required; import alone does not activate anything');
  const path = process.argv.find(arg => arg.startsWith('--config='))?.slice(9); assert.ok(path);
  try {
    const driver = await startReportFaultDriver(path); console.log(JSON.stringify({ state: 'listening', ...driver.ready }));
    let closing = false; const close = async () => { if (closing) return; closing = true; await driver.close(); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
  } catch { console.error('Report fault driver refused startup; verify its private configuration and identity. No provider or mission was started.'); process.exitCode = 1; }
}

import { readFile, unlink } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { del } from '@vercel/blob';
import postgres from 'postgres';

if (process.env.RUN_MISSION_REPORT_TESTS !== '1') throw new Error('Set RUN_MISSION_REPORT_TESTS=1 to remove the retained disposable fixture.');
const fixture = JSON.parse(await readFile('.data/mission-fixture.json', 'utf8'));
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
try {
  const { data, error } = await admin.auth.admin.getUserById(fixture.userId);
  assert.equal(error, null);
  assert.match(data.user.email, /^mission-test-[a-f0-9-]+@example\.com$/, 'Only a generated test account may be removed');
  const workspaces = await sql`select id from pat_workspaces where user_id=${fixture.userId}`;
  for (const workspace of workspaces) {
    const path = `http://localhost:3000/api/workspaces/${workspace.id}/sandboxes`;
    const state = await fetch(path, { headers: { cookie: fixture.cookie } });
    assert.ok(state.ok, 'Read the test workspace sandboxes before deleting its owner');
    for (const sandbox of (await state.json()).sessions) {
      const stopped = await fetch(path, { method: 'POST', headers: { cookie: fixture.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id: sandbox.id, action: 'stop' }) });
      assert.ok(stopped.ok, 'Stop only this disposable workspace sandbox');
    }
  }
  const paths = await sql`select distinct i.blob_path from pat_workspace_items i join pat_workspaces w on w.id=i.workspace_id where w.user_id=${fixture.userId} and i.blob_path is not null`;
  for (const row of paths) await del(row.blob_path, { token: process.env.WORKSPACE_BLOB_READ_WRITE_TOKEN });
  await sql`delete from pat_user where id=${fixture.userId}`;
  assert.equal((await admin.auth.admin.deleteUser(fixture.userId)).error, null);
  await unlink('.data/mission-fixture.json');
  console.log('Disposable mission account, workspace data, private blobs and local session cookie removed.');
} finally { await sql.end(); }

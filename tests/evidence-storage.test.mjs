import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { rm } from 'node:fs/promises';
import { put, get, del, workspaceStorageToken } from '../server/utils/evidence-storage.ts';

test('isolated evidence storage persists exact bytes and refuses remote or escaping scopes', async () => {
  const names = ['SYNA_ISOLATED_STORAGE_ROOT', 'PAT_RUNTIME_SCOPE', 'DATABASE_URL', 'VERCEL'];
  const before = Object.fromEntries(names.map(key => [key, process.env[key]]));
  const base = resolve('.data/autonomy-isolation');
  const root = resolve(base, `storage-unit-${randomUUID()}`);
  Object.assign(process.env, { SYNA_ISOLATED_STORAGE_ROOT: root, PAT_RUNTIME_SCOPE: 'autonomy-test:storage', DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:5432/syna_test_autonomy_storage', VERCEL: '' });
  const options = { token: workspaceStorageToken(), access: 'private', contentType: 'text/plain', addRandomSuffix: true };
  try {
    const data = Buffer.from('Actual isolated evidence bytes');
    const item = await put(`pat/workspaces/${randomUUID()}/${randomUUID()}/proof.txt`, data, options);
    assert.deepEqual(Buffer.from(await new Response((await get(item.pathname, options)).stream).arrayBuffer()), data);
    await assert.rejects(get('../outside.txt', options), /Invalid evidence/);
    await assert.rejects(get('https://shared-store.example/proof', options), /Invalid evidence/);
    await del(item.pathname, options);
    assert.equal(await get(item.pathname, options), null);
    for (const changes of [
      { DATABASE_URL: 'postgres://fixture:fixture@shared.example/syna_test_autonomy_storage' },
      { PAT_RUNTIME_SCOPE: 'production' }, { VERCEL: '1' },
      { SYNA_ISOLATED_STORAGE_ROOT: resolve('.data/outside') },
      { DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:5432/app' },
    ]) {
      const previous = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
      Object.assign(process.env, changes);
      assert.throws(workspaceStorageToken, /requires an isolated/);
      Object.assign(process.env, previous);
    }
  } finally {
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const child = relative(base, root);
    assert.ok(child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
    await rm(root, { recursive: true, force: true });
  }
});

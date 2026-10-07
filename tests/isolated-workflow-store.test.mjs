import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { resolveLocalWorkflowWorldDataDirectory } from '../node_modules/eve/dist/src/internal/workflow/local-world-data-directory.js';
import { selectIsolatedWorkflowStore, verifyIsolatedWorkflowStore } from './helpers/isolated-workflow-store.mjs';

const sourceSha256 = 'a'.repeat(64);
const selection = purpose => ({ id: randomUUID(), purpose, sourceSha256, fresh: true });
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'syna-workflow-isolation-'));
  t.after(async () => {
    const child = relative(resolve(tmpdir()), await realpath(root));
    assert.ok(child.startsWith('syna-workflow-isolation-') && !child.includes(sep));
    // Only the test-owned directory and its links; never their targets.
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('actual installed Eve path resolves to a fresh physical smoke store; old runs are preserved', async t => {
  const root = await fixture(t);
  const actual = resolveLocalWorkflowWorldDataDirectory(resolve(root, 'eve'));
  await mkdir(actual, { recursive: true });
  await writeFile(resolve(actual, 'old-run.json'), '{"pending":true}');
  const receipt = await selectIsolatedWorkflowStore(root, selection('smoke'));
  assert.equal(receipt.linkPath, actual);
  assert.equal(await realpath(actual), receipt.dataDirectory);
  assert.deepEqual(await readdir(actual), []);
  const preserved = (await readdir(resolve(root, 'workflow-stores'))).find(name => name.startsWith('legacy-'));
  assert.equal(await readFile(resolve(root, 'workflow-stores', preserved, 'old-run.json'), 'utf8'), '{"pending":true}');
  assert.deepEqual(await verifyIsolatedWorkflowStore(root, receipt), receipt);
});

test('acceptance and smoke never share state; worker restart preserves exact acceptance data and source', async t => {
  const root = await fixture(t);
  const smoke = await selectIsolatedWorkflowStore(root, selection('smoke'));
  await writeFile(resolve(smoke.dataDirectory, 'smoke-only.json'), '{}');
  const chosen = selection('acceptance');
  const acceptance = await selectIsolatedWorkflowStore(root, chosen);
  assert.deepEqual(await readdir(acceptance.linkPath), []);
  await writeFile(resolve(acceptance.linkPath, 'own-run.json'), '{"checkpoint":1}');
  const restarted = await selectIsolatedWorkflowStore(root, { ...chosen, fresh: false });
  assert.deepEqual(restarted, acceptance);
  assert.equal(await readFile(resolve(restarted.linkPath, 'own-run.json'), 'utf8'), '{"checkpoint":1}');
  assert.equal(await readFile(resolve(smoke.dataDirectory, 'smoke-only.json'), 'utf8'), '{}');
  await assert.rejects(selectIsolatedWorkflowStore(root, chosen), /already exists/);
  await assert.rejects(selectIsolatedWorkflowStore(root, { ...chosen, fresh: false, sourceSha256: 'b'.repeat(64) }), /frozen runtime/);
  await assert.rejects(selectIsolatedWorkflowStore(root, { ...selection('acceptance'), fresh: false }), /required for restart/);
});

test('changed junction, arbitrary existing link and escaped selections fail before touching foreign data', async t => {
  const root = await fixture(t), outside = await fixture(t);
  const receipt = await selectIsolatedWorkflowStore(root, selection('acceptance'));
  await writeFile(resolve(outside, 'keep.json'), 'unchanged');
  await unlink(receipt.linkPath);
  await symlink(outside, receipt.linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyIsolatedWorkflowStore(root, receipt), /selected store/);
  await assert.rejects(selectIsolatedWorkflowStore(root, selection('smoke')), /escapes/);
  assert.equal(await readFile(resolve(outside, 'keep.json'), 'utf8'), 'unchanged');
  await assert.rejects(selectIsolatedWorkflowStore(root, { ...selection('smoke'), id: '../elsewhere' }), /identity/);
  await assert.rejects(selectIsolatedWorkflowStore(root, { ...selection('smoke'), purpose: 'legacy' }), /identity/);
});

test('receipt spoofing and physical store replaced by a junction are rejected', async t => {
  const root = await fixture(t), outside = await fixture(t);
  const receipt = await selectIsolatedWorkflowStore(root, selection('acceptance'));
  const metadata = resolve(receipt.directory, 'receipt.json');
  await writeFile(metadata, JSON.stringify({ ...receipt, dataDirectory: outside }));
  await assert.rejects(verifyIsolatedWorkflowStore(root, receipt), /unexpected path/);
  await writeFile(metadata, JSON.stringify(receipt));
  await unlink(receipt.linkPath);
  await rmdir(receipt.dataDirectory); // Validated own empty directory, not recursive.
  await symlink(outside, receipt.dataDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(receipt.dataDirectory, receipt.linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyIsolatedWorkflowStore(root, receipt), /physically owned/);
});

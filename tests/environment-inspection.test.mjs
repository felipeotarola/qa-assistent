import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectEnvironment, environmentInspectionCommand } from '../agent/lib/environment-inspection.mjs';

function inspect(root) {
  return JSON.parse(execFileSync(process.execPath, ['-e', `console.log(JSON.stringify((${inspectEnvironment.toString()})(${JSON.stringify(root)}, require)))`], { encoding: 'utf8' }));
}

test('inventory finds a reusable checkout, preserves edits and strips remote credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qa-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'existing-app'), project = join(repo, 'package');
  await mkdir(join(project, 'node_modules'), { recursive: true });
  const manifest = JSON.stringify({ name: 'example', scripts: { dev: 'do-not-execute-this' }, packageManager: 'pnpm@10' });
  await writeFile(join(project, 'package.json'), manifest);
  await writeFile(join(project, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['remote', 'add', 'origin', 'https://user:SECRET@github.com/owner/project.git?token=SECRET']);
  git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'Fixture']);
  await writeFile(join(project, 'pending.txt'), 'Keep this work');
  const before = await readFile(join(repo, '.git', 'index'));
  const state = inspect(root);
  assert.equal(state.repositories.length, 1);
  assert.equal(state.repositories[0].directory, repo);
  assert.equal(state.repositories[0].origin, 'https://github.com/owner/project');
  assert.equal(state.repositories[0].branch, 'main');
  assert.equal(state.repositories[0].commit, git(['rev-parse', 'HEAD']));
  assert.equal(state.repositories[0].hasChanges, true);
  assert.equal(JSON.stringify(state).includes('SECRET'), false);
  assert.equal(state.projects[0].dependenciesPresent, true);
  assert.deepEqual(state.projects[0].lockfiles, ['pnpm-lock.yaml']);
  assert.ok(state.disk.availableBytes > 0);
  assert.equal(await readFile(join(project, 'package.json'), 'utf8'), manifest);
  assert.equal(await readFile(join(project, 'pending.txt'), 'utf8'), 'Keep this work');
  assert.deepEqual(await readFile(join(repo, '.git', 'index')), before);
});

test('inventory skips symlinked trees and dependency contents; incomplete manifests are explicit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qa-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scope = join(root, 'workspace'), outside = join(root, 'unrelated');
  await mkdir(join(scope, 'node_modules', 'dependency'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, 'package.json'), '{"name":"unrelated"}');
  await writeFile(join(scope, 'node_modules', 'dependency', 'package.json'), '{"name":"dependency"}');
  await symlink(outside, join(scope, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(scope, 'package.json'), 'broken json');
  const state = inspect(scope);
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0].error, 'Could not read package.json');
  assert.ok(environmentInspectionCommand().length < 16000, 'Fits sandbox command limit');
});

test('large inventories remain parseable within the supervisor output cap', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qa-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let n = 0; n < 25; n++) {
    const dir = join(root, `app-${n}`); await mkdir(dir);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`script${i}`, 'x'.repeat(500)])) }));
  }
  const state = inspect(root);
  assert.equal(state.truncated, true);
  assert.ok(state.projects.length > 0);
  assert.ok(JSON.stringify(state).length <= 24000);
});

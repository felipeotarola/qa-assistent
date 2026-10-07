// Materialize test-owned Git repositories only. Never installs, starts a
// service, rewrites a remote or configures the product's Git transport.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative, sep, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { repoHash, validateRepoManifest } from './repo-benchmark-contract.mjs';

const execute = promisify(execFile);
export async function materializeRepoFixtures(destination) {
  const allowed = resolve('.data/autonomy-isolation/repo-fixtures'), root = resolve(destination);
  assert.ok(root.startsWith(allowed + sep) && relative(allowed, root).split(sep).length === 1, 'Use a fresh direct child of the isolated repo-fixtures directory');
  await mkdir(allowed, { recursive: true }); await mkdir(root); // Existing output is immutable; never delete/replace.
  const platform = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:path|pathext|systemroot|windir|comspec|temp|tmp)$/i.test(key)));
  const git = async (cwd, args) => (await execute('git', ['-c', 'core.hooksPath=' + resolve(root, 'empty-hooks'), '-c', 'commit.gpgsign=false', ...args], {
    cwd, windowsHide: true, timeout: 15000, encoding: 'utf8',
    env: { ...platform, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: resolve(root, 'empty-gitconfig'), GIT_AUTHOR_NAME: 'Syna Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Syna Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
  })).stdout.trim();
  await mkdir(resolve(root, 'empty-hooks')); await writeFile(resolve(root, 'empty-gitconfig'), '');
  const base = resolve('tests/fixtures/repo-benchmark'), oracleBytes = await readFile(resolve(base, 'oracle.json'));
  const oracle = JSON.parse(oracleBytes), repositories = [];
  for (const [scenario, spec] of Object.entries(oracle.scenarios)) {
    const source = resolve(base, spec.fixture), directory = resolve(root, spec.fixture);
    await mkdir(directory); const files = [];
    for (const entry of (await readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      assert.ok(entry.isFile() && !entry.isSymbolicLink());
      const bytes = Buffer.from((await readFile(resolve(source, entry.name), 'utf8')).replace(/\r\n/g, '\n'));
      await writeFile(resolve(directory, entry.name), bytes); files.push({ path: entry.name, sha256: repoHash(bytes) });
    }
    await git(directory, ['init', '--initial-branch=main']); await git(directory, ['-c', 'core.autocrlf=false', 'add', '--all']);
    await git(directory, ['commit', '--no-verify', '-m', 'Service project']);
    repositories.push({ scenario, fixture: spec.fixture, url: `https://github.com/syna-autonomy-fixture/${spec.fixture}`, commit: await git(directory, ['rev-parse', 'HEAD']), tree: await git(directory, ['rev-parse', 'HEAD^{tree}']), files,
      filesSha256: repoHash(JSON.stringify(files)), lockfileSha256: files.find(f => f.path === 'package-lock.json').sha256,
      runtime: 'node24', packageManager: 'npm', directory: '.', codeChangesAllowed: false, localPath: directory });
  }
  const manifest = validateRepoManifest({ version: 1, kind: 'syna-repository-benchmark', fixtureId: basename(root), oracleSha256: repoHash(oracleBytes), oracleNotServed: true, oracleNotInPrompt: true,
    transport: { kind: 'unbound', reason: 'Local Git commits exist, but no isolated GitHub transport or public remote has been configured.' }, repositories });
  await writeFile(resolve(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { path: resolve(root, 'manifest.json'), commits: repositories.map(({ scenario, commit }) => ({ scenario, commit })), runnable: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv[2], '--materialize', 'Explicit --materialize required; this does not make the repositories fetchable');
  console.log(JSON.stringify(await materializeRepoFixtures(resolve('.data/autonomy-isolation/repo-fixtures', randomUUID()))));
}

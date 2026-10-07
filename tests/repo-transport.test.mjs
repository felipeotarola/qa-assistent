import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitRequest, gitCgiResponse } from './fixtures/repo-benchmark/git-server.mjs';
import { validateTransportPlan, assertTransportQuiescent, transportDockerfile, assertDerivedTransportImage } from './helpers/repo-transport-linux.mjs';

const digest = 'a'.repeat(64), commit = 'b'.repeat(40);
function plan() {
  const id = randomUUID();
  return { version: 1, kind: 'syna-repo-transport-plan', id, distro: 'SynaAutonomy-ff9dd82d1748', root: '/var/lib/syna-autonomy/repo-fixtures/' + id,
    host: '198.51.100.10', port: 18080, baseImage: 'sha256:' + digest, baseTag: '127.0.0.1:9/syna-repo-fixture-base:' + id, imageTag: 'syna-repo-fixture:' + id, manifestSha256: digest, serverSha256: digest, provisionerSha256: digest, oracleIncluded: false, productionDnsChanged: false,
    repositories: ['library', 'keyless', 'configured'].map(name => ({ name, url: `https://github.com/syna-autonomy-fixture/${name}`, transportUrl: `http://198.51.100.10:18080/${name}`, commit, tree: commit, bundleSha256: digest })) };
}
function state(p) {
  return { dockerRootDir: '/var/lib/syna-autonomy/docker', daemonArgs: ['/usr/bin/dockerd', '--data-root', '/var/lib/syna-autonomy/docker', '--exec-root', '/var/run/syna-autonomy/docker', '--cgroup-parent', '/syna-autonomy-ff9dd82d1748'],
    runnerProcesses: [], executorProcesses: [], ephemeralContainers: [], runnerListener: '', transportListener: '', addressPresent: false, rootExists: false, imageExists: false,
    baseImage: p.baseImage, baseUser: '', repoNetwork: { name: 'qa-repo-net', subnets: ['172.30.0.0/24'], ipv6: false }, lockExists: false };
}

test('three exact fixture repositories, canonical Git spelling and read-only smart protocol', () => {
  for (const name of ['library', 'keyless', 'configured']) {
    for (const suffix of ['', '.git']) {
      assert.equal(gitRequest('GET', `/${name}${suffix}/info/refs?service=git-upload-pack`).pathInfo, `/${name}.git/info/refs`);
      assert.equal(gitRequest('POST', `/${name}${suffix}/git-upload-pack`, { 'content-type': 'application/x-git-upload-pack-request' }).name, name);
    }
  }
});

test('no oracle, receive-pack, suffix redirect, normalization trick or authorization reaches Git', () => {
  for (const path of ['/oracle.json', '/plan.json', '/library.git/HEAD', '/library.git/config', '/library.git/git-receive-pack', '/library.git/info/refs?service=git-receive-pack',
    '/library-other/info/refs?service=git-upload-pack', '/library.git.git/info/refs?service=git-upload-pack', '/library/../configured/info/refs?service=git-upload-pack',
    '/%6cibrary/info/refs?service=git-upload-pack', '/library/info/refs?service=git-upload-pack&x=1', 'http://github.com/library/info/refs?service=git-upload-pack']) {
    assert.throws(() => gitRequest('GET', path));
  }
  for (const headers of [{ authorization: 'Bearer nope' }, { cookie: 'private' }, { 'content-encoding': 'gzip' }, { 'content-length': '1048577' }, { 'content-length': '-1' }]) assert.throws(() => gitRequest('GET', '/library/info/refs?service=git-upload-pack', headers));
  assert.throws(() => gitRequest('POST', '/library/info/refs?service=git-upload-pack'));
  assert.throws(() => gitRequest('POST', '/library/git-upload-pack', { 'content-type': 'text/plain' }));
});

test('CGI emits bounded bytes and an allowlisted response; never a redirect or cookie', () => {
  const bytes = Buffer.from('Content-Type: application/x-git-upload-pack-result\r\nCache-Control: private\r\n\r\n0000');
  const result = gitCgiResponse(bytes); assert.equal(result.status, 200); assert.equal(result.body.toString(), '0000'); assert.equal(result.headers['cache-control'], 'no-store');
  for (const headers of ['Location: https://github.com', 'Set-Cookie: data=private', 'Status: 302 Found', 'X-Exec: anything']) assert.throws(() => gitCgiResponse(Buffer.from(`Content-Type: text/plain\n${headers}\n\nno`)));
  assert.throws(() => gitCgiResponse(Buffer.alloc(8 * 1024 * 1024 + 1)));
});

test('private image adds only three full URL mappings, pinned base and no project/oracle COPY', () => {
  const p = plan(), dockerfile = transportDockerfile(p);
  assert.ok(dockerfile.startsWith(`FROM ${p.baseTag}\n`)); assert.ok(!dockerfile.includes('FROM sha256:'), 'Local image IDs must never be mistaken for registry names'); assert.equal((dockerfile.match(/git config --system url\./g) || []).length, 3);
  assert.ok(dockerfile.includes('\nUSER 1000:1000\nLABEL'), 'Derived image returns to the explicit non-root runtime user');
  for (const repo of p.repositories) assert.ok(dockerfile.includes(`url.${repo.transportUrl}.insteadOf ${repo.url}`));
  assert.ok(!dockerfile.includes('COPY') && !dockerfile.includes('oracle') && !dockerfile.includes('github.com/.insteadOf'));
  for (const change of [p => p.repositories[0].url = 'https://github.com/', p => p.repositories[0].transportUrl += '/escape', p => p.root += '/../other', p => p.baseImage = 'qa-repo-runner:latest', p => p.oracleIncluded = true]) {
    const bad = structuredClone(p); change(bad); assert.throws(() => validateTransportPlan(bad));
  }
});

test('local base tag and actual derived layer prefix are both required', () => {
  const p = plan(), base = { Id: p.baseImage, Os: 'linux', Architecture: 'amd64', RootFS: { Layers: ['sha256:' + '1'.repeat(64)] } };
  const image = { Id: 'sha256:' + '2'.repeat(64), Os: 'linux', Architecture: 'amd64', RootFS: { Layers: [...base.RootFS.Layers, 'sha256:' + '3'.repeat(64)] }, Config: { User: '1000:1000', Labels: { 'syna.repo.fixture': p.id, 'syna.isolation': p.distro } } };
  assert.doesNotThrow(() => assertDerivedTransportImage(p, base, image));
  assert.throws(() => assertDerivedTransportImage(p, { ...base, Id: image.Id }, image));
  for (const mutate of [x => x.RootFS.Layers[0] = image.Id, x => x.RootFS.Layers.pop(), x => x.Config.User = 'root', x => x.Config.Labels['syna.isolation'] = 'other']) {
    const bad = structuredClone(image); mutate(bad); assert.throws(() => assertDerivedTransportImage(p, base, bad));
  }
});

test('quiescence gate refuses every live writer, collision and foreign daemon without adopting it', () => {
  const p = plan(); assert.doesNotThrow(() => assertTransportQuiescent(state(p), p));
  assert.doesNotThrow(() => assertTransportQuiescent({ ...state(p), baseUser: 'node' }, p), 'The pinned installed Node image uses its named node user');
  for (const [field, value] of Object.entries({ dockerRootDir: '/var/lib/docker', runnerProcesses: [123], executorProcesses: [124], ephemeralContainers: ['qa-preview-owned'], runnerListener: 'LISTEN', transportListener: 'LISTEN', addressPresent: true, rootExists: true, imageExists: true, baseImage: 'sha256:' + 'b'.repeat(64), baseUser: '1000', lockExists: true })) {
    assert.throws(() => assertTransportQuiescent({ ...state(p), [field]: value }, p), field);
  }
  const foreign = state(p); foreign.daemonArgs[6] = '/foreign'; assert.throws(() => assertTransportQuiescent(foreign, p));
  assert.throws(() => assertTransportQuiescent({ ...state(p), repoNetwork: { name: 'qa-repo-net', subnets: ['10.0.0.0/24'], ipv6: false } }, p));
});

test('actual local Git bundle preserves commit/tree and is fetchable without fixture oracle', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'syna-repo-transport-test-'));
  const platform = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:path|pathext|systemroot|windir|comspec|temp|tmp)$/i.test(key)));
  await writeFile(resolve(root, 'config'), '');
  const env = { ...platform, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: resolve(root, 'config'), GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
  const git = async args => (await promisify(execFile)('git', ['-c', 'core.hooksPath=' + resolve(root, 'absent-hooks'), '-c', 'commit.gpgsign=false', ...args], { env, cwd: root, windowsHide: true, timeout: 10000, encoding: 'utf8' })).stdout.trim();
  try {
    await mkdir(resolve(root, 'source')); await git(['-C', 'source', 'init', '--initial-branch=main']); await writeFile(resolve(root, 'source', 'README.md'), 'Actual repository\n');
    await git(['-C', 'source', 'add', '.']); await git(['-C', 'source', 'commit', '-m', 'Fixture']);
    const commit = await git(['-C', 'source', 'rev-parse', 'HEAD']), tree = await git(['-C', 'source', 'rev-parse', 'HEAD^{tree}']);
    await git(['-C', 'source', 'bundle', 'create', resolve(root, 'fixture.bundle'), 'HEAD']); await git(['clone', '--bare', 'fixture.bundle', 'fixture.git']);
    assert.equal(await git(['--git-dir=fixture.git', 'rev-parse', 'HEAD']), commit); assert.equal(await git(['--git-dir=fixture.git', 'rev-parse', 'HEAD^{tree}']), tree);
    assert.equal(await git(['--git-dir=fixture.git', 'ls-tree', '--name-only', 'HEAD']), 'README.md');
  } finally {
    assert.ok(root.startsWith(resolve(tmpdir()) + sep) && root.split(sep).at(-1).startsWith('syna-repo-transport-test-'));
    await rm(root, { recursive: true, force: true });
  }
});

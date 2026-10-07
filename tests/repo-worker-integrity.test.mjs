import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { REPO_WORKER_PROBE } from './helpers/repo-worker-integrity.mjs';

// Execute the exact production probe text against synthetic Linux observations.
// No WSL, process, Docker, HTTP or filesystem call escapes these adapters.
const root = '/opt/syna-autonomy/source';
const shared = ['mission-execution.mjs', 'mission-environment.mjs', 'environment-plan-identity.mjs', 'preview-handoff.mjs'];
const dependencies = ['shared/preview-handoff.mjs', 'infra/browser/policy.mjs'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function observe(change = () => {}) {
  const source = new Map([
    ...['infra/repo-runner/server.mjs', 'infra/codex-worker/worker.mjs', 'infra/execution/admission.mjs', 'infra/browser/policy.mjs', ...shared.map(name => `shared/${name}`)]
      .map(name => [`${root}/${name}`, { bytes: `original:${name}`, mtimeMs: 1, ctimeMs: 1 }]),
  ]);
  change(source);
  const stat = `42 (node) ${['S', ...Array(18).fill('0'), '100', ...Array(30).fill('0')].join(' ')}`;
  const data = new Map([
    ['/proc/42/cmdline', `/opt/syna-autonomy/node/bin/node\0${root}/infra/repo-runner/server.mjs\0`],
    ['/proc/42/stat', stat], ['/proc/stat', 'btime 1000\n'],
    ['/proc/42/environ', ['AUTONOMY_APP_URL=http://127.0.0.1:58000', 'REPO_APP_URL=http://127.0.0.1:58000', 'REPO_RUNNER_PORT=58091', 'REPO_RUNNER_HOST=127.0.0.1', 'REPO_RUNNER_DATA=/var/lib/syna-autonomy/runner', 'CODEX_ACCESS_MODE=shared'].join('\0')],
    ['/opt/syna-autonomy/node/bin/node', 'synthetic-node'], ['/opt/qa-codex/codex', 'synthetic-codex'],
  ]);
  const fs = {
    realpathSync(file) {
      if (file === '/proc/42/exe') return '/opt/syna-autonomy/node/bin/node';
      if (source.get(file)?.alias) return '/unowned/alias';
      if (file.startsWith(root) && !source.has(file) && ![...source.keys()].some(key => key.startsWith(`${file}/`))) throw Error(`ENOENT: ${file}`);
      return file;
    },
    readdirSync(dir, options) {
      if (dir === '/proc') return ['42'];
      assert.equal(options.withFileTypes, true);
      return [...source.keys()].filter(file => path.posix.dirname(file) === dir).map(file => ({ name: path.posix.basename(file), isDirectory: () => false, isSymbolicLink: () => !!source.get(file).symlink }));
    },
    lstatSync(file) {
      const row = source.get(file); assert.ok(row, `Missing source: ${file}`);
      return { ...row, isFile: () => true, isSymbolicLink: () => !!row.symlink };
    },
    readFileSync(file) {
      if (source.has(file)) return source.get(file).bytes;
      assert.ok(data.has(file), `Unplanned file read: ${file}`); return data.get(file);
    },
  };
  const execFileSync = (command, args) => {
    if (command === 'getconf') { assert.deepEqual(args, ['CLK_TCK']); return '100'; }
    if (command === 'ss') { assert.deepEqual(args, ['-H', '-ltnp', 'sport = :58091']); return 'LISTEN 0 511 127.0.0.1:58091 0.0.0.0:* users:(("node",pid=42,fd=3))'; }
    assert.equal(command, 'docker'); assert.deepEqual(args.slice(0, 2), ['image', 'inspect']);
    assert.ok(['qa-repo-runner:public', 'qa-browser:execution'].includes(args[2]));
    return JSON.stringify([{ Id: `sha256:${'a'.repeat(64)}` }]);
  };
  const imports = "import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import assert from 'node:assert/strict'; import {execFileSync} from 'node:child_process';";
  assert.equal(REPO_WORKER_PROBE.split(imports).length, 2, 'Keep the real probe import contract explicit');
  let output;
  // Normalise VM arrays only at the fake syscall boundary; real assertions in
  // the probe itself remain unchanged inside its own realm.
  const nativeExec = (command, args) => execFileSync(command, Array.from(args));
  runInNewContext(REPO_WORKER_PROBE.replace(imports, ''), { fs, path: path.posix, crypto, assert, execFileSync: nativeExec, console: { log(value) { assert.equal(output, undefined); output = JSON.parse(value); } } }, { timeout: 1000 });
  assert.ok(output); return output;
}

test('native worker closure includes both preview handoff and policy source bytes', () => {
  const receipt = observe();
  for (const name of dependencies) assert.deepEqual(receipt.files.filter(row => row.path === name), [{ path: name, sha256: hash(`original:${name}`) }]);
  assert.equal(receipt.sourceSha256, hash(JSON.stringify(receipt.files)));
});

test('either direct dependency byte change changes the actual closure digest', () => {
  const original = observe();
  for (const name of dependencies) {
    const modified = observe(files => { files.get(`${root}/${name}`).bytes += ':changed'; });
    assert.notEqual(modified.sourceSha256, original.sourceSha256);
    assert.notEqual(modified.files.find(row => row.path === name).sha256, original.files.find(row => row.path === name).sha256);
  }
});

test('missing new handoff or native policy fails closed, never optional', () => {
  for (const name of dependencies) assert.throws(() => observe(files => files.delete(`${root}/${name}`)), /ENOENT/);
});

test('direct dependency symlink and escaped realpath are rejected', () => {
  for (const name of dependencies) for (const key of ['symlink', 'alias']) assert.throws(() => observe(files => { files.get(`${root}/${name}`)[key] = true; }));
});

test('dependency modified after runner process start is rejected', () => {
  for (const name of dependencies) for (const key of ['mtimeMs', 'ctimeMs']) assert.throws(() => observe(files => { files.get(`${root}/${name}`)[key] = 2_000_000; }), /changed after/);
});

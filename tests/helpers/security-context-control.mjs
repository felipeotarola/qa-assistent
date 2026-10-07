// Private test-only file handshake; no process start/stop, sockets or app API.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export function securityContextPaths({ serviceRoot, service, nonce, pid }) {
  assert.ok(['eve', 'web'].includes(service) && resolve(dirname(serviceRoot), service) === resolve(serviceRoot));
  assert.match(nonce, /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const root = dirname(resolve(serviceRoot)), stem = `${service}-${nonce}-${pid}`;
  return { control: resolve(root, `security-context-control-${stem}.json`), output: resolve(root, `security-context-${stem}.jsonl`) };
}

/** Caller first verifies actual PID/creation time, frozen output and both app
 * processes using the existing isolation guard. This helper cannot attest that
 * a self-reported source hash is the code actually serving the application. */
export async function requestSecurityContextCheckpoint(binding, { action, trialPromptHash, armNonce = null, signal, timeoutMs = 3000 }) {
  assert.ok(['arm', 'checkpoint'].includes(action)); assert.match(trialPromptHash, /^[a-f0-9]{64}$/);
  assert.ok(action === 'arm' ? armNonce === null : /^[a-f0-9]{64}$/.test(armNonce));
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 10000);
  const paths = securityContextPaths(binding); assert.equal(await realpath(binding.serviceRoot), resolve(binding.serviceRoot));
  const requestNonce = randomBytes(32).toString('hex'), now = Date.now(), deadline = Math.min(Date.parse(binding.deadlineAt), now + timeoutMs);
  assert.ok(Number.isFinite(deadline) && deadline > now); signal?.throwIfAborted();
  // An existing control file must still be our ordinary file, never a link.
  try { assert.equal(await realpath(paths.control), paths.control); assert.ok((await stat(paths.control)).isFile()); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const request = { version: 1, nonce: binding.nonce, pid: binding.pid, requestNonce, action, trialPromptHash, armNonce, deadlineAt: new Date(deadline).toISOString() };
  const temporary = paths.control + `.${requestNonce}.tmp`;
  await writeFile(temporary, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  signal?.throwIfAborted(); await rename(temporary, paths.control);
  // Submission is never retried: a timeout/abort is an unknown measurement.
  let delay = 20;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      assert.equal(await realpath(paths.output), paths.output); const info = await stat(paths.output);
      assert.ok(info.isFile() && info.size <= 8 * 1024 * 1024);
      const text = await readFile(paths.output, 'utf8');
      // Ignore a partial final write until the next bounded observation.
      const complete = text.endsWith('\n') ? text.trimEnd().split('\n') : text.split('\n').slice(0, -1);
      for (let i = complete.length - 1; i >= 0; i--) {
        const row = JSON.parse(complete[i]);
        if (row.kind === 'checkpoint' && row.requestNonce === requestNonce) return { request, checkpoint: { ...row, pid: binding.pid, nonce: binding.nonce }, text: complete.join('\n') + '\n' };
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((resolve, reject) => {
      const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(done, Math.min(delay, deadline - Date.now()));
      const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason); };
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    });
    delay = Math.min(250, delay * 2);
  }
  throw new Error('Security context checkpoint unavailable; coverage unknown');
}

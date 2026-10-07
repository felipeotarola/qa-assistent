import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { MemoryDocumentConflictError, type MemoryDocument, type MemoryDocumentBackend } from 'eve/memory/file';

const versionPattern = /^[a-f0-9-]{36}$/;
const isChild = (parent: string, path: string) => {
  const child = relative(parent, path);
  return !!child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

/** Explicit isolated acceptance backend; ordinary runtimes continue using Blob. */
export function isolatedMemory(): MemoryDocumentBackend | undefined {
  const configured = process.env.SYNA_ISOLATED_MEMORY_ROOT;
  if (!configured) return undefined;
  const allowed = resolve('.data/autonomy-isolation');
  const root = resolve(configured);
  let database: URL;
  try { database = new URL(process.env.DATABASE_URL || ''); }
  catch { throw new Error('Local memory requires an isolated loopback test runtime and directory.'); }
  if (process.env.VERCEL || !/^autonomy-test:[a-z0-9-]+$/.test(process.env.PAT_RUNTIME_SCOPE || '')
    || !['postgres:', 'postgresql:'].includes(database.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)
    || !/^\/syna_test_autonomy_[a-z0-9_]+$/.test(database.pathname)
    || !isChild(allowed, root)) {
    throw new Error('Local memory requires an isolated loopback test runtime and directory.');
  }
  async function directory(key: string) {
    if (!key || Buffer.byteLength(key) > 4096) throw new Error('Invalid isolated memory key');
    const path = resolve(root, createHash('sha256').update(key).digest('hex'));
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (!isChild(await realpath(allowed), await realpath(root)) || !isChild(await realpath(root), await realpath(path))) {
      throw new Error('Isolated memory directory escapes the test store');
    }
    return path;
  }
  async function latest(path: string, signal: AbortSignal): Promise<MemoryDocument | null> {
    let document: MemoryDocument | null = null;
    const visited = new Set<string>();
    for (;;) {
      signal.throwIfAborted();
      const next = resolve(path, `next-${document?.version || 'root'}.json`);
      try {
        if ((await lstat(next)).isSymbolicLink()) throw new Error('Invalid isolated memory symlink');
        const parsed = JSON.parse(await readFile(next, { encoding: 'utf8', signal })) as MemoryDocument;
        if (typeof parsed.content !== 'string' || Buffer.byteLength(parsed.content) > 65536
          || !versionPattern.test(parsed.version) || visited.has(parsed.version) || visited.size >= 10000) {
          throw new Error('Invalid isolated memory document');
        }
        visited.add(parsed.version);
        document = parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return document;
        throw error;
      }
    }
  }
  return {
    async read({ key, signal }) { signal.throwIfAborted(); return latest(await directory(key), signal); },
    async write({ key, content, expectedVersion, signal }) {
      signal.throwIfAborted();
      if (Buffer.byteLength(content) > 65536) throw new Error('Isolated memory document exceeds 64 KiB');
      if (expectedVersion !== null && !versionPattern.test(expectedVersion)) throw new MemoryDocumentConflictError(key);
      const path = await directory(key);
      if ((await latest(path, signal))?.version !== (expectedVersion ?? undefined)) throw new MemoryDocumentConflictError(key);
      const document = { content, version: randomUUID() };
      const temporary = resolve(path, `${document.version}.tmp`);
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(document)); await file.sync(); }
      finally { await file.close(); }
      try {
        signal.throwIfAborted();
        // Immutable successor files provide an atomic conditional write without
        // a lock that could strand the acceptance runtime after a worker crash.
        await link(temporary, resolve(path, `next-${expectedVersion || 'root'}.json`));
        return document;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new MemoryDocumentConflictError(key);
        throw error;
      } finally { await unlink(temporary); }
    },
  };
}

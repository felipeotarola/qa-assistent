import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { get as blobGet, put as blobPut, del as blobDel } from '@vercel/blob';

// Production keeps private Blob storage. An explicit, fenced local adapter lets
// isolated acceptance tests exercise actual bytes without writing shared stores.
function isolatedRoot() {
  const configured = process.env.SYNA_ISOLATED_STORAGE_ROOT;
  if (!configured) return null;
  const database = new URL(process.env.DATABASE_URL || 'invalid:');
  const allowed = resolve('.data/autonomy-isolation');
  const root = resolve(configured);
  const child = relative(allowed, root);
  if (process.env.VERCEL || !/^autonomy-test:[a-z0-9-]+$/.test(process.env.PAT_RUNTIME_SCOPE || '')
    || !['postgres:', 'postgresql:'].includes(database.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)
    || !/^\/syna_test_autonomy_[a-z0-9_]+$/.test(database.pathname)
    || !child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('Local evidence storage requires an isolated loopback test runtime and directory.');
  }
  return root;
}

function localPath(root: string, pathname: string) {
  if (!/^pat\/workspaces\/[a-f0-9-]+\/[a-f0-9-]+\/[^/\\]+$/i.test(pathname)
    || pathname.split('/').some(part => part === '.' || part === '..')
    || pathname.includes(':') || [...pathname].some(char => char.charCodeAt(0) < 32)) throw new Error('Invalid evidence storage path');
  const path = resolve(root, pathname);
  if (!path.startsWith(root + sep)) throw new Error('Evidence path is outside the isolated store');
  return path;
}

export function workspaceStorageToken() {
  if (isolatedRoot()) return 'isolated-filesystem';
  const token = process.env.WORKSPACE_BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('Configure WORKSPACE_BLOB_READ_WRITE_TOKEN for a private Blob store');
  return token;
}

export async function put(pathname: string, bytes: Buffer, options: { token: string; access: 'private'; contentType: string; addRandomSuffix: boolean }) {
  const root = isolatedRoot();
  if (!root) return blobPut(pathname, bytes, options);
  const saved = options.addRandomSuffix ? `${pathname}-${randomUUID()}` : pathname;
  const path = localPath(root, saved);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: 'wx' });
  return { pathname: saved };
}

export async function get(pathname: string, options: { token: string; access: 'private'; abortSignal?: AbortSignal }): Promise<{ statusCode: 200; stream: ReadableStream<Uint8Array> } | null> {
  const root = isolatedRoot();
  if (!root) {
    const result = await blobGet(pathname, options);
    return result?.statusCode === 200 ? { statusCode: 200, stream: result.stream } : null;
  }
  options.abortSignal?.throwIfAborted();
  try {
    const bytes = await readFile(localPath(root, pathname), { signal: options.abortSignal });
    return { statusCode: 200, stream: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function del(pathname: string, options: { token: string }) {
  const root = isolatedRoot();
  if (!root) return blobDel(pathname, options);
  try { await unlink(localPath(root, pathname)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

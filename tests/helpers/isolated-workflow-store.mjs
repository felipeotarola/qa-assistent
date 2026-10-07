import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const samePath = (left, right) => relative(resolve(left), resolve(right)) === '';
const exists = path => lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
function inside(root, path) {
  const child = relative(root, path);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Workflow state path escapes the owned application');
}
async function physical(root, path) {
  inside(root, path);
  await mkdir(path, { recursive: true });
  if (!samePath(path, await realpath(path))) throw new Error('Workflow state directory must be physical and owned');
}
function location(root, { id, purpose, sourceSha256 }) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
    || !['smoke', 'acceptance'].includes(purpose) || !/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error('Explicit workflow store identity is required');
  root = resolve(root);
  const directory = resolve(root, 'workflow-stores', `${purpose}-${id}`);
  inside(root, directory);
  return { root, directory, dataDirectory: resolve(directory, 'data'), linkPath: resolve(root, 'eve/.eve/.workflow-data') };
}

/** Eve's installed local world explicitly uses cwd/.eve/.workflow-data.
 * Environment variables cannot override that explicit dataDir. The caller
 * holds both process/artifact locks and has proved both services stopped. */
export async function selectIsolatedWorkflowStore(root, selection) {
  const paths = location(root, selection);
  if (!samePath(paths.root, await realpath(paths.root))) throw new Error('Application root must be physical');
  await physical(paths.root, resolve(paths.root, 'workflow-stores'));
  await physical(paths.root, resolve(paths.root, 'eve'));
  await physical(paths.root, resolve(paths.root, 'eve/.eve'));
  const previous = await exists(paths.directory);
  if (selection.fresh && previous) throw new Error('Fresh workflow store already exists');
  if (!selection.fresh && !previous) throw new Error('Existing workflow store is required for restart');
  let receipt;
  if (!previous) {
    await mkdir(paths.directory);
    await mkdir(paths.dataDirectory);
    if ((await readdir(paths.dataDirectory)).length) throw new Error('New workflow store is not empty');
    receipt = { version: 1, id: selection.id, purpose: selection.purpose, sourceSha256: selection.sourceSha256,
      createdAt: new Date().toISOString(), emptyAtCreation: true, ...paths };
    await writeFile(resolve(paths.directory, 'receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  } else {
    receipt = JSON.parse(await readFile(resolve(paths.directory, 'receipt.json'), 'utf8'));
    await verifyReceipt(paths, receipt, selection);
  }
  const existing = await exists(paths.linkPath);
  if (existing?.isSymbolicLink()) {
    const target = await realpath(paths.linkPath);
    inside(resolve(paths.root, 'workflow-stores'), target);
    // Never remove an arbitrary state link, even if it happens to be local.
    const active = JSON.parse(await readFile(resolve(paths.root, 'workflow-store-active.json'), 'utf8'));
    await verifyIsolatedWorkflowStore(paths.root, active);
    if (!samePath(target, paths.dataDirectory)) await unlink(paths.linkPath);
  } else if (existing) {
    if (!existing.isDirectory() || !samePath(paths.linkPath, await realpath(paths.linkPath))) throw new Error('Unmanaged workflow state is not a physical directory');
    const preserved = resolve(paths.root, 'workflow-stores', `legacy-${randomUUID()}`);
    inside(paths.root, paths.linkPath); inside(paths.root, preserved);
    // Native rename within this exact owned root; preserve every old run.
    await rename(paths.linkPath, preserved);
    await writeFile(resolve(paths.root, `preserved-workflows-${Date.now()}.json`), JSON.stringify({ original: paths.linkPath, preserved, movedAt: new Date().toISOString() }, null, 2), { flag: 'wx' });
  }
  if (!await exists(paths.linkPath)) await symlink(paths.dataDirectory, paths.linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(resolve(paths.root, 'workflow-store-active.json'), JSON.stringify(receipt, null, 2));
  return verifyIsolatedWorkflowStore(paths.root, receipt);
}

async function verifyReceipt(paths, receipt, selection) {
  if (!samePath(paths.root, await realpath(paths.root))) throw new Error('Application root must be physical');
  if (receipt.version !== 1 || receipt.id !== selection.id || receipt.purpose !== selection.purpose
    || receipt.sourceSha256 !== selection.sourceSha256 || receipt.emptyAtCreation !== true
    || !Number.isFinite(Date.parse(receipt.createdAt))) throw new Error('Workflow store receipt does not match its frozen runtime');
  for (const key of ['root', 'directory', 'dataDirectory', 'linkPath']) if (!samePath(receipt[key], paths[key])) throw new Error('Workflow store receipt has an unexpected path');
  for (const directory of [resolve(paths.root, 'workflow-stores'), paths.directory, paths.dataDirectory, resolve(paths.root, 'eve/.eve')]) {
    inside(paths.root, directory);
    if (!samePath(directory, await realpath(directory))) throw new Error('Workflow store path is not physically owned');
  }
}

/** No queue reads/delivery; validates the actual directory Eve will open. */
export async function verifyIsolatedWorkflowStore(root, expected) {
  const paths = location(root, expected);
  const receipt = JSON.parse(await readFile(resolve(paths.directory, 'receipt.json'), 'utf8'));
  await verifyReceipt(paths, receipt, expected);
  const link = await lstat(paths.linkPath);
  if (!link.isSymbolicLink() || !samePath(await realpath(paths.linkPath), paths.dataDirectory)) throw new Error('Eve workflow directory is not bound to the selected store');
  return receipt;
}

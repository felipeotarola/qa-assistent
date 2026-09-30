import { mkdir, stat, statfs, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validId } from './store.mjs';
const run = promisify(execFile);

// A fixed-size filesystem provides a hard write limit, including across stop/resume.
// Only this trusted service mounts disks. Containers have no mount capabilities.
export class SandboxStorage {
  constructor(root, sizeGiB = 2) { this.root = root; this.sizeGiB = sizeGiB; }
  paths(id) {
    if (!validId(id)) throw new Error('Invalid storage ID');
    return { disk: `${this.root}/${id}.ext4`, mount: `${this.root}/${id}` };
  }
  async prepare(id) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const { disk, mount } = this.paths(id);
    if (!await stat(disk).catch(() => null)) {
      const free = await statfs(this.root);
      if (free.bavail * free.bsize < (8 + this.sizeGiB) * 1024 ** 3) throw new Error('VPS disk reserve reached');
      await run('truncate', ['-s', `${this.sizeGiB}G`, disk]);
      await run('mkfs.ext4', ['-q', '-F', '-m', '0', disk]);
    }
    await mkdir(mount, { recursive: true, mode: 0o700 });
    try { await run('mountpoint', ['-q', mount]); }
    catch { await run('mount', ['-o', 'loop,nosuid,nodev', disk, mount]); }
    await run('chown', ['1000:1000', mount]);
    return mount;
  }
  async remove(id) {
    const { disk, mount } = this.paths(id);
    let mounted = true;
    try { await run('mountpoint', ['-q', mount]); } catch { mounted = false; }
    if (mounted) await run('umount', [mount]);
    // Never recurse: the unmounted directory must be empty.
    await rm(mount, { recursive: false, force: true }).catch(async error => {
      if (error.code === 'ERR_FS_EISDIR' || error.code === 'EISDIR') await run('rmdir', [mount]); else throw error;
    });
    await rm(disk, { force: true });
  }
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statfs } from 'node:fs/promises';
import { loadavg, freemem, totalmem } from 'node:os';
const exec = promisify(execFile);
export function workerHealth(directory, budget) {
  let cached, expires = 0;
  return async () => {
    if (cached && expires > Date.now()) return cached;
    const disk = await statfs(directory), errors = [];
    try {
      const runtime = await exec('docker', ['info', '--format', '{{json .Runtimes}}'], { timeout: 5000 });
      if (!JSON.parse(runtime.stdout).runsc) errors.push('gVisor runtime unavailable');
      await exec('docker', ['image', 'inspect', process.env.EXECUTION_IMAGE || 'qa-repo-runner:public'], { timeout: 5000, maxBuffer: 64000 });
      await exec('docker', ['network', 'inspect', 'qa-repo-net'], { timeout: 5000 });
    } catch { errors.push('Worker image or Docker network unavailable'); }
    const diskFreeBytes = disk.bavail * disk.bsize;
    if (diskFreeBytes < 8 * 1024 ** 3) errors.push('Disk reserve below 8 GiB');
    cached = { workerId: process.env.WORKER_ID || 'vps-1', ready: !errors.length, errors, profiles: ['node22', 'node24', 'java21', 'python3'], diskFreeBytes, freeMemoryBytes: freemem(), totalMemoryBytes: totalmem(), load: loadavg(), capacity: budget.snapshot(), checkedAt: new Date().toISOString() };
    expires = Date.now() + 5000; return cached;
  };
}

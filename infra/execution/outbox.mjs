import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validId } from './store.mjs';

export class ResultOutbox {
  constructor({ directory, deliver, now = Date.now }) {
    this.directory = directory; this.deliver = deliver; this.now = now; this.busy = false; this.receipts = new Map();
  }
  async receipt(id) {
    if (!validId(id)) throw new Error('Invalid run ID');
    if (this.receipts.has(id)) return this.receipts.get(id);
    try { const value = JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8')); this.receipts.set(id, value); return value; }
    catch (error) { if (error.code === 'ENOENT') return { attempts: 0, nextAt: 0 }; throw error; }
  }
  async save(id, value) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${id}.json`);
    await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
    this.receipts.set(id, value);
  }
  async drain(jobs) {
    if (this.busy) return; this.busy = true;
    try {
      // Oldest first; delayed/permanently rejected entries cannot starve others.
      let count = 0;
      for (const job of [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        const receipt = await this.receipt(job.id);
        if (receipt.ackedAt || receipt.rejectedAt || receipt.nextAt > this.now()) continue;
        if (++count > 10) break;
        let status = 0;
        try { status = await this.deliver(job); } catch { /* Retry transport failures. */ }
        const attempts = receipt.attempts + 1;
        if (status >= 200 && status < 300) await this.save(job.id, { attempts, ackedAt: this.now() });
        else if ([400, 404, 409, 410, 422].includes(status)) await this.save(job.id, { attempts, rejectedAt: this.now(), status });
        else await this.save(job.id, { attempts, status, nextAt: this.now() + Math.min(300000, 1000 * 2 ** Math.min(attempts, 8)) });
      }
    } finally { this.busy = false; }
  }
}

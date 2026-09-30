import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const validId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);

// A bounded replay journal and its snapshot are committed together. Consumers can
// always recover from a cursor older than the retained journal using the snapshot.
export class ExecutionStore extends EventEmitter {
  constructor(directory, { history = 128 } = {}) {
    super(); this.setMaxListeners(256); this.directory = directory; this.history = history;
    this.records = new Map(); this.writes = new Map();
  }
  async read(id) {
    if (!validId(id)) throw new Error('Invalid execution ID');
    if (this.records.has(id)) return this.records.get(id);
    try {
      const record = JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8'));
      this.records.set(id, record); return record;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  publish(id, kind, type, snapshot) {
    if (!validId(id)) return Promise.reject(new Error('Invalid execution ID'));
    // Capture now, not when an earlier disk write completes.
    const value = structuredClone(snapshot);
    const pending = (this.writes.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const old = await this.read(id);
      const event = { version: 1, executionId: id, kind, seq: (old?.seq || 0) + 1, at: new Date().toISOString(), type, snapshot: value };
      // Historical entries contain metadata only. Full state is sent on reconnect;
      // this avoids storing 128 copies of a 64KB terminal log.
      const entry = { ...event }; delete entry.snapshot;
      const record = { ...event, events: [...(old?.events || []), entry].slice(-this.history) };
      const file = join(this.directory, `${id}.json`);
      await writeFile(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
      this.records.set(id, record); this.emit('event', event); return event;
    });
    this.writes.set(id, pending);
    void pending.finally(() => { if (this.writes.get(id) === pending) this.writes.delete(id); }).catch(() => {});
    return pending;
  }
  async flush() { await Promise.all(this.writes.values()); }
}

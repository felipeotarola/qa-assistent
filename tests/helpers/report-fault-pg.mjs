// Test-only PostgreSQL transport. No server is opened by importing this file.
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { randomUUID } from 'node:crypto';

const MAX_FRAME = 16 * 1024 * 1024;
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,150}$/.test(value);
function stringAt(bytes, offset) {
  const end = bytes.indexOf(0, offset); assert.ok(end >= offset, 'Malformed PostgreSQL string');
  return [bytes.toString('utf8', offset, end), end + 1];
}

/** Only the three queue identity parameters are retained. Neither SQL, other
 * Bind values, credentials nor row contents leave this parser. */
function queueInsert(sql) {
  const match = /^\s*insert\s+into\s+"?pat_mission_reports"?\s*\(([^)]+)\)\s*values\s*\(([^)]+)\)/i.exec(sql);
  if (!match) return null;
  const columns = match[1].split(',').map(column => column.trim().replace(/^"|"$/g, ''));
  const values = match[2].split(',').map(value => value.trim());
  const indices = {};
  for (const [key, column] of Object.entries({ reportId: 'id', missionId: 'mission_id', snapshotId: 'snapshot_id' })) {
    const parameter = /^\$(\d+)$/.exec(values[columns.indexOf(column)] ?? '');
    if (!parameter) return null;
    indices[key] = Number(parameter[1]) - 1;
  }
  return indices;
}

export class ReportCommitBoundary {
  #statements = new Map(); #portals = new Map(); #pending = []; #candidate = null; #ambiguous = false; #transaction = false;
  operation(sql) {
    const insert = queueInsert(sql); if (insert) return { kind: 'insert', indices: insert };
    if (/^\s*begin(?:\s+[^;]*)?;?\s*$/i.test(sql)) return { kind: 'begin' };
    if (/^\s*commit;?\s*$/i.test(sql)) return { kind: 'commit' };
    if (/^\s*rollback;?\s*$/i.test(sql)) return { kind: 'rollback' };
    return { kind: 'other' };
  }
  enqueue(operation) { assert.ok(this.#pending.length < 1024, 'Too many pipelined operations'); this.#pending.push(operation ?? { kind: 'other' }); }
  client(frame) {
    const type = String.fromCharCode(frame[0]), bytes = frame.subarray(5);
    if (type === 'P') {
      const [name, offset] = stringAt(bytes, 0), [sql] = stringAt(bytes, offset);
      if (this.#statements.size >= 256 && !this.#statements.has(name)) throw new Error('Too many prepared statements');
      this.#statements.set(name, this.operation(sql));
    } else if (type === 'B') {
      const [portal, first] = stringAt(bytes, 0), [statement, second] = stringAt(bytes, first);
      let offset = second; const formatCount = bytes.readInt16BE(offset); offset += 2;
      assert.ok(formatCount >= 0 && formatCount <= 6553);
      const formats = []; for (let i = 0; i < formatCount; i++, offset += 2) formats.push(bytes.readInt16BE(offset));
      const count = bytes.readInt16BE(offset); offset += 2; assert.ok(count >= 0);
      const operation = this.#statements.get(statement), indices = operation?.indices, candidate = {};
      for (let i = 0; i < count; i++) {
        const length = bytes.readInt32BE(offset); offset += 4;
        assert.ok(length >= -1 && offset + Math.max(0, length) <= bytes.length, 'Malformed Bind parameter');
        if (indices) for (const [key, index] of Object.entries(indices)) if (index === i) {
          const format = formatCount === 1 ? formats[0] : formats[i] ?? 0;
          if (length < 1 || format !== 0) return this.#portals.delete(portal);
          candidate[key] = bytes.toString('utf8', offset, offset + length);
        }
        offset += Math.max(0, length);
      }
      if (this.#portals.size >= 256 && !this.#portals.has(portal)) throw new Error('Too many portals');
      this.#portals.set(portal, indices ? Object.values(candidate).length === 3 && Object.values(candidate).every(id) ? { kind: 'insert', candidate } : { kind: 'other' } : operation);
    } else if (type === 'E') {
      const [portal] = stringAt(bytes, 0); this.enqueue(this.#portals.get(portal));
    } else if (type === 'Q') {
      const [sql] = stringAt(bytes, 0);
      // Application transactions use one statement per simple Query. We never
      // guess correspondence for arbitrary multi-statement SQL or literal IDs.
      const operation = this.operation(sql);
      if (sql.replace(/;\s*$/, '').includes(';') || operation.kind === 'insert') this.#ambiguous = true;
      this.enqueue(operation.kind === 'insert' ? { kind: 'other' } : operation);
    } else if (type === 'C') {
      const [name] = stringAt(bytes, 1); (bytes[0] === 83 ? this.#statements : this.#portals).delete(name);
    }
  }
  server(frame) {
    const type = String.fromCharCode(frame[0]);
    if (type === 'E') { this.#candidate = null; this.#ambiguous = true; this.#pending = []; }
    if (type === 'C') {
      const [command] = stringAt(frame, 5);
      const operation = this.#pending.shift();
      if (!operation) this.#ambiguous = true;
      if (command === 'BEGIN' && operation?.kind === 'begin') this.#transaction = true;
      if (operation?.kind === 'insert') {
        if (!this.#transaction || command !== 'INSERT 0 1' || this.#candidate) this.#ambiguous = true;
        this.#candidate = operation.candidate;
      }
      if (command === 'COMMIT' || command === 'ROLLBACK') {
        const receipt = command === 'COMMIT' && operation?.kind === 'commit' && this.#transaction && !this.#ambiguous ? this.#candidate : null;
        this.#candidate = null; this.#ambiguous = false; this.#transaction = false; return receipt;
      }
    }
    if (type === 'Z') {
      if (this.#pending.length) this.#ambiguous = true;
      if (frame[5] === 73) { this.#candidate = null; this.#ambiguous = false; this.#transaction = false; }
    }
    return null;
  }
}

export class PgFrames {
  #buffer = Buffer.alloc(0); #startup;
  constructor(startup = false) { this.#startup = startup; }
  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const frames = [];
    while (this.#buffer.length >= (this.#startup ? 4 : 5)) {
      const length = this.#buffer.readInt32BE(this.#startup ? 0 : 1), total = length + (this.#startup ? 0 : 1);
      assert.ok(length >= (this.#startup ? 8 : 4) && total <= MAX_FRAME, 'Invalid or excessive PostgreSQL frame');
      if (this.#buffer.length < total) break;
      const frame = this.#buffer.subarray(0, total); this.#buffer = this.#buffer.subarray(total);
      if (this.#startup) {
        assert.equal(frame.readInt32BE(4), 196608, 'Fault transport requires explicit unencrypted isolated PostgreSQL protocol3');
        frames.push({ startup: true, bytes: frame }); this.#startup = false;
      } else frames.push({ startup: false, bytes: frame });
    }
    assert.ok(this.#buffer.length <= MAX_FRAME, 'PostgreSQL frame buffer exceeded');
    return frames;
  }
}

/** verifyCommitted must use a separate READ ONLY connection to the real owned
 * backend, check exact report/mission/snapshot/attempt/runtime/owner, and journal
 * an authorized fault before returning true. The COMMIT packet is already from
 * PostgreSQL; dropping it cannot undo or fabricate that committed queue. */
export function createReportPgFaultProxy({ upstreamHost = '127.0.0.1', upstreamPort, database, verifyCommitted, onDropped = async () => {}, maxConnections = 16, gateTimeoutMs = 3000 }) {
  assert.equal(upstreamHost, '127.0.0.1'); assert.ok(Number.isInteger(upstreamPort) && upstreamPort > 1024 && upstreamPort < 65536);
  assert.match(database, /^syna_test_autonomy_[a-z0-9_]+$/);
  assert.equal(typeof verifyCommitted, 'function'); assert.ok(gateTimeoutMs > 0 && gateTimeoutMs <= 5000);
  assert.ok(Number.isInteger(maxConnections) && maxConnections >= 1 && maxConnections <= 32);
  const sockets = new Set(); let connections = 0;
  const server = createServer(downstream => {
    if (connections >= maxConnections) { downstream.destroy(); return; }
    connections++; const upstream = connect({ host: upstreamHost, port: upstreamPort }), connectionId = randomUUID();
    sockets.add(downstream); sockets.add(upstream);
    const clientFrames = new PgFrames(true), serverFrames = new PgFrames(), boundary = new ReportCommitBoundary();
    let closed = false;
    const close = () => { if (closed) return; closed = true; connections--; downstream.destroy(); upstream.destroy(); sockets.delete(downstream); sockets.delete(upstream); };
    downstream.on('error', close); upstream.on('error', close); downstream.on('close', close); upstream.on('close', close);
    void (async () => {
      try { for await (const chunk of downstream) for (const frame of clientFrames.push(chunk)) {
        if (frame.startup) {
          const fields = new Map(); let offset = 8;
          while (offset < frame.bytes.length - 1) { const [key, next] = stringAt(frame.bytes, offset), [value, end] = stringAt(frame.bytes, next); fields.set(key, value); offset = end; }
          assert.equal(fields.get('database'), database, 'Database differs from the owned isolated database');
        } else boundary.client(frame.bytes);
        await write(upstream, frame.bytes);
      } } catch { close(); }
    })();
    void (async () => {
      try { for await (const chunk of upstream) for (const frame of serverFrames.push(chunk)) {
        const candidate = boundary.server(frame.bytes);
        if (candidate) {
          const controller = new AbortController(), timer = setTimeout(() => controller.abort(), gateTimeoutMs);
          let drop = false;
          try { drop = await Promise.race([verifyCommitted({ ...candidate, connectionId }, controller.signal), new Promise(resolve => controller.signal.addEventListener('abort', () => resolve(false), { once: true }))]); }
          catch { /* Failed observer cannot certify a fault. Forward the real ACK. */ }
          finally { clearTimeout(timer); controller.abort(); }
          if (drop === true) { close(); await onDropped({ ...candidate, connectionId, droppedAt: new Date().toISOString() }); return; }
        }
        await write(downstream, frame.bytes);
      } } catch { close(); }
    })();
  });
  return { server, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

function write(socket, bytes) {
  if (socket.destroyed) return Promise.reject(new Error('Transport closed'));
  return new Promise((resolve, reject) => socket.write(bytes, error => error ? reject(error) : resolve()));
}

// Actual PostgreSQL syntax/isolation probe only; no auth, service or model call.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { readIsolationFixture } from './autonomy-isolation.mjs';
import { utcObservationTypes } from './utc-postgres-observation.mjs';
import { observeEvidence } from './evidence-observer.mjs';

const fixture = await readIsolationFixture();
const sql = postgres(fixture.databaseUrl, { prepare: false, max: 1, types: utcObservationTypes, connection: { TimeZone: 'UTC', default_transaction_read_only: 'on' } });
try {
  assert.equal((await sql`show transaction_read_only`)[0].transaction_read_only, 'on');
  const rows = await observeEvidence(sql, `evidence-audit-missing-${randomUUID()}`, fixture.runtimeScope);
  assert.equal(Object.keys(rows).length, 13); assert.ok(Object.values(rows).every(value => Array.isArray(value) && value.length === 0));
  console.log(JSON.stringify({ check: 'evidence-observer-schema', queries: 13, actualDatabase: 'owned-isolated-loopback', readOnly: true, modelCalls: 0, mutations: 0, result: 'passed' }));
} finally { await sql.end(); }

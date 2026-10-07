import assert from 'node:assert/strict';
import postgres from 'postgres';
import { assertIsolatedDatabaseUrl } from './helpers/autonomy-isolation.mjs';
import { parseUtcTimestamp, utcObservationTypes } from './helpers/utc-postgres-observation.mjs';

// Actual isolated PostgreSQL, SELECT only. No app, auth, model or worker starts.
const url = assertIsolatedDatabaseUrl(process.env.DATABASE_URL), previousZone = process.env.TZ;
const checks = [];
try {
  for (const observerZone of ['UTC', 'Europe/Stockholm']) {
    process.env.TZ = observerZone;
    for (const databaseZone of ['UTC', 'Europe/Stockholm']) {
      const sql = postgres(url, { prepare: false, max: 1, types: utcObservationTypes,
        connection: { TimeZone: databaseZone, default_transaction_read_only: 'on' } });
      try {
        const [row] = await sql`select '2026-10-05 15:01:17.738'::timestamp as naive,
          '2026-10-05 17:01:17.738+02'::timestamptz as zoned,
          '2026-01-05 15:01:17.738'::timestamp as winter,
          current_setting('transaction_read_only') as readonly`;
        assert.equal(row.naive.toISOString(), '2026-10-05T15:01:17.738Z');
        assert.equal(row.zoned.toISOString(), '2026-10-05T15:01:17.738Z');
        assert.equal(row.winter.toISOString(), '2026-01-05T15:01:17.738Z');
        assert.equal(row.readonly, 'on');
        checks.push(`UTC timestamp observation with observer=${observerZone}, database=${databaseZone}`);
      } finally { await sql.end(); }
    }
  }
  process.env.TZ = 'Europe/Stockholm';
  const unmodified = postgres(url, { prepare: false, max: 1, connection: { TimeZone: 'UTC', default_transaction_read_only: 'on' } });
  try {
    const [row] = await unmodified`select '2026-10-05 15:01:17.738'::timestamp as naive, '2026-10-05 15:01:17.738+00'::timestamptz as zoned`;
    assert.equal(row.naive.toISOString(), '2026-10-05T13:01:17.738Z');
    assert.equal(row.zoned.toISOString(), '2026-10-05T15:01:17.738Z');
    checks.push('Default raw parser reproduces the original two-hour October observation error');
  } finally { await unmodified.end(); }
  assert.throws(() => parseUtcTimestamp('2026-10-05 15:01:17+02'), /Invalid UTC/);
  assert.throws(() => parseUtcTimestamp('not a timestamp'), /Invalid UTC/);
  checks.push('Parser refuses offset-bearing or malformed values for the naive timestamp OID');
  console.log(JSON.stringify({ passed: checks.length, checks, database: 'actual isolated PostgreSQL', mutations: 'none', externalExecution: 'none' }));
} finally {
  if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone;
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { securityProtectedRow } from './helpers/evidence-security-observer.mjs';

test('security projection ignores only the mission scheduler observation timestamp', () => {
  const row = { id: 'mission', reconciled_at: 'old', updated_at: 'old', revision: 1, lifecycle: 'closed', config: { goal: 'private' } };
  const original = structuredClone(row);
  assert.deepEqual(securityProtectedRow('pat_missions', row), securityProtectedRow('pat_missions', { ...row, reconciled_at: 'new' }));
  for (const patch of [{ updated_at: 'new' }, { revision: 2 }, { lifecycle: 'running' }, { config: { goal: 'changed' } }]) {
    assert.notDeepEqual(securityProtectedRow('pat_missions', row), securityProtectedRow('pat_missions', { ...row, ...patch }));
  }
  assert.deepEqual(securityProtectedRow('pat_mission_reports', row), row);
  assert.deepEqual(row, original);
});

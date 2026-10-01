import test from 'node:test';
import assert from 'node:assert/strict';
import { activityRailState } from '../shared/activity-rail.ts';

test('rail shows blocked configuration even alongside active or completed jobs', () => {
  assert.equal(activityRailState(['completed', 'running', 'needs_configuration']).status, 'waiting');
  assert.equal(activityRailState(['dispatch_unknown']).status, 'waiting');
});
test('rail keeps queued and cleanup work active and reports worker failures', () => {
  for (const status of ['queued', 'cleaning', 'configuring']) assert.equal(activityRailState([status]).status, 'working');
  for (const status of ['failed', 'timeout', 'interrupted']) assert.equal(activityRailState([status]).status, 'error');
});
test('completion and a ready sandbox are not a test approval or active agent', () => {
  for (const status of ['completed', 'passed', 'ready', 'cancelled']) {
    assert.deepEqual(activityRailState([status]), { status: 'idle', detail: 'Visa senaste aktivitet' });
  }
});

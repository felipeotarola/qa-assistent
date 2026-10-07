import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceScopedLimitations } from '../shared/mission.ts';

test('source limitations remain local when discovery and verified setup disagree', () => {
  const discovery = { sourceType: 'research', sourceId: 'discovery-1', limitations: ['Observerad appversion saknas.'] };
  const setup = { sourceType: 'setup', sourceId: 'apply-1', limitations: ['HTTP 200 bevisar inte fungerande inloggning.'] };
  const before = structuredClone([discovery, setup]);
  assert.deepEqual([
    ...sourceScopedLimitations(discovery, 'Upptäck webbplats'),
    ...sourceScopedLimitations(setup, 'Verifiera miljö'),
  ], [
    'Upptäck webbplats [research:discovery-1]: Observerad appversion saknas.',
    'Verifiera miljö [setup:apply-1]: HTTP 200 bevisar inte fungerande inloggning.',
  ]);
  assert.deepEqual([discovery, setup], before, 'Saved observations and history are immutable');
});

test('equal limitations on different sources keep both identities; no invented gap for an empty list', () => {
  const first = { sourceType: 'test', sourceId: 'run-1', limitations: ['Sessionens inloggning är inte verifierad.'] };
  const second = { ...first, sourceId: 'run-2' };
  assert.equal(new Set([...sourceScopedLimitations(first, 'Test'), ...sourceScopedLimitations(second, 'Test')]).size, 2);
  assert.deepEqual(sourceScopedLimitations({ ...first, limitations: [] }, 'Test'), []);
});

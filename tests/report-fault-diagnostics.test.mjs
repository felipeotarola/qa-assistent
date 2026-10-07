import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportFreshnessDiagnostics } from './helpers/report-fault-diagnostics.mjs';
const log = (id, reason) => `[mission-report] Attempt failed {\n  id: '${id}',\n  type: 'Error',\n  reason: '${reason}',\n  diagnostic: undefined\n}\n`;
test('only exact final freshness diagnostic for the affected queue counts; generic failures are not green', () => {
  const exact = log('report', 'Evidence changed during review');
  const proof = reportFreshnessDiagnostics(log('other', 'Evidence changed during review') + exact + log('report', 'generation_or_storage_error'), 'report');
  assert.equal(proof.occurrences, 1); assert.equal(proof.matchedDiagnosticSha256.length, 1);
  assert.ok(!JSON.stringify(proof).includes('diagnostic:'));
  for (const text of [log('other', 'Evidence changed during review'), log('report', 'generation_or_storage_error'), exact.replace("id: 'report',", "id: 'report',\n  id: 'other',"), exact.replace('type: \'Error\'', 'type: \'TimeoutError\''), `source prose: ${exact}`]) assert.equal(reportFreshnessDiagnostics(text, 'report').occurrences, 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolDetails } from '../shared/tool-details.ts';
test('details bound logs and redact credential-shaped values', () => {
  const rows = toolDetails({ stdout: 'x'.repeat(7000), command: 'curl -H "Authorization: Bearer abcdef" https://example.com?token=xyz', password: 'hidden' });
  assert.ok(rows[0].text.length < 6100);
  assert.ok(!JSON.stringify(rows).includes('abcdef'));
  assert.ok(!JSON.stringify(rows).includes('xyz'));
  assert.equal(rows.length, 2);
});

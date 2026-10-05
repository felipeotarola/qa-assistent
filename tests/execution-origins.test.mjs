import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedOrigins, frameAncestorsPolicy } from '../infra/execution/http.mjs';

test('production live viewer and event streams share the exact allowed app origins', t => {
  const before = process.env.EXECUTION_ORIGINS;
  t.after(() => { if (before === undefined) delete process.env.EXECUTION_ORIGINS; else process.env.EXECUTION_ORIGINS = before; });
  delete process.env.EXECUTION_ORIGINS;
  assert.ok(allowedOrigins().includes('https://qa.felipeotarola.com'));
  assert.ok(allowedOrigins().includes('https://qa-assistent.vercel.app'));
  assert.equal(allowedOrigins().includes('https://other.example'), false);
  assert.equal(frameAncestorsPolicy(), `frame-ancestors ${allowedOrigins().join(' ')}`);
  process.env.EXECUTION_ORIGINS = ' https://staging.example/,https://staging.example ';
  assert.deepEqual(allowedOrigins(), ['https://staging.example']);
  assert.equal(frameAncestorsPolicy(), 'frame-ancestors https://staging.example');
  process.env.EXECUTION_ORIGINS = '';
  assert.deepEqual(allowedOrigins(), []);
  assert.equal(frameAncestorsPolicy(), "frame-ancestors 'none'");
});

test('origin configuration rejects wildcards, credentials, paths and policy injection', () => {
  for (const value of ['*', 'https://*.example', 'https://app.example; frame-ancestors *', 'https://user:password@app.example', 'https://app.example/path', 'https://app.example?key=value', 'https://app.example#fragment', 'file:///tmp/viewer', 'null']) {
    assert.throws(() => allowedOrigins(value), undefined, value);
  }
});

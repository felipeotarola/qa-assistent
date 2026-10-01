import test from 'node:test';
import assert from 'node:assert/strict';
import { isCodexBackground, finalizeBackgroundParams } from '../shared/codex-handoff.mjs';

test('only accepted active jobs end the coordinator tool loop', () => {
  for (const status of ['starting', 'running']) assert.equal(isCodexBackground({ status }), true);
  for (const status of ['completed', 'failed', 'cancelled', 'timeout', 'interrupted', undefined]) assert.equal(isCodexBackground({ status }), false);
  assert.equal(isCodexBackground(null), false);
});
test('handoff model call cannot poll, sleep in bash or start duplicate work', () => {
  const params = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'Start the repo' }] }], tools: [{ name: 'codex' }, { name: 'bash' }], toolChoice: { type: 'auto' }, temperature: 0.2 };
  const finalized = finalizeBackgroundParams(params);
  assert.deepEqual(finalized.tools, []); assert.deepEqual(finalized.toolChoice, { type: 'none' });
  assert.equal(finalized.temperature, 0.2); assert.equal(finalized.prompt.length, 2);
  assert.match(finalized.prompt.at(-1).content, /End this turn now/);
  assert.equal(params.tools.length, 2); assert.equal(params.prompt.length, 1);
});

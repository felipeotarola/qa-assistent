// Run explicitly on the VPS after subscription login. Uses one small model turn.
import assert from 'node:assert/strict';
import { CodexClient, threadOptions } from './client.mjs';
let resolve, reject, calls = 0;
const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
const timer = setTimeout(() => reject(new Error('Smoke test timed out')), 90000);
const client = new CodexClient({
  onRequest: async msg => {
    assert.equal(msg.method, 'item/tool/call'); assert.equal(msg.params.tool, 'ping'); calls++;
    return { success: true, contentItems: [{ type: 'inputText', text: 'QAA subscription bridge verified' }] };
  },
  onEvent: msg => { if (msg.method === 'turn/completed') resolve(msg.params.turn.status); },
});
try {
  await client.initialize();
  const { thread } = await client.request('thread/start', { ...threadOptions, dynamicTools: [{ type: 'function', name: 'ping', description: 'Verify the QAA bridge.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] });
  await client.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Call ping exactly once. Then reply with its result. No other tools or actions.', text_elements: [] }] });
  assert.equal(await finished, 'completed'); assert.equal(calls, 1);
  console.log('PASS: subscription auth and scoped dynamic tool round trip');
} finally { clearTimeout(timer); await client.close(); }

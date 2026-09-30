import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectActivity } from '../shared/agent-activity.ts';
const user = id => ({ id, role: 'user', parts: [] });
const assistant = parts => ({ id: 's:a', role: 'assistant', parts });
const tool = (id, state, output = {}, input = {}) => ({ type: 'dynamic-tool', toolName: 'workspace', toolCallId: id, state, input, output });
test('activity isolates the latest task and stable calls deduplicate on replay', () => {
  const part = tool('c1', 'output-available');
  const result = projectActivity([user('old'), assistant([tool('old','input-available')]), user('new'), assistant([part,part])], false);
  assert.equal(result.turnId, 'new'); assert.equal(result.steps.length, 1); assert.equal(result.steps[0].status, 'done');
});
test('tool errors, approvals and incomplete calls never turn into success', () => {
  const result = projectActivity([user('u'), assistant([tool('1','output-available',{error:'failed'}),tool('2','approval-requested'),tool('3','input-available'),tool('4','output-denied')])], false);
  assert.deepEqual(result.steps.map(s=>s.status), ['error','waiting','unconfirmed','error']);
  assert.equal(projectActivity([assistant([tool('1','input-available')])],true).steps[0].status,'working');
});
test('only successful saves expose material links; failed tests are not tool errors', () => {
  const item = { id:'item',title:'Saved',content:{kind:'text'} };
  const result = projectActivity([assistant([tool('read','output-available',{item},{action:'read'}),tool('save','output-available',{item},{action:'create'}),tool('bad','output-available',{item,error:'failed'},{action:'update'}),{type:'dynamic-tool',toolName:'test_run',toolCallId:'run',state:'output-available',output:{outcome:'failed'}}])], false);
  assert.deepEqual(result.steps.filter(s=>s.item).map(s=>s.item.id), ['item']);
  assert.equal(result.steps.at(-1).status, 'done');
});
test('raw inputs, credentials and reasoning are not projected into the panel', () => {
  const result = projectActivity([assistant([{type:'reasoning',text:'internal'},tool('1','output-available',{password:'secret'},{password:'secret'}),{type:'text',text:'Visible answer'}])], false);
  assert.ok(!JSON.stringify(result).includes('secret')); assert.ok(!JSON.stringify(result).includes('internal')); assert.equal(result.texts[0].text,'Visible answer');
});

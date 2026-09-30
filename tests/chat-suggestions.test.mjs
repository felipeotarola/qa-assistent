import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestChatSuggestions } from '../shared/chat-suggestions.ts';

const choices = [{ label: 'Granska testplanen', prompt: 'Granska testplanen och markera saknade förutsättningar.' }];
const user = () => ({ role: 'user', parts: [{ type: 'text', text: 'Vad är nästa steg?' }] });
const answer = () => ({ role: 'assistant', parts: [{ type: 'text', text: 'Välj hur du vill fortsätta.' }] });
const suggested = (suggestions = choices, state = 'output-available') => ({ role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'suggest_next_steps', toolCallId: 'suggest', state, output: { suggestions } }] });

test('follow-ups survive a separate final message and JSON history reload', () => {
  const messages = [user(), suggested(), answer()];
  assert.deepEqual(latestChatSuggestions(messages, 'ready'), choices);
  assert.deepEqual(latestChatSuggestions(JSON.parse(JSON.stringify(messages)), 'ready'), choices);
});

test('new requests, streaming and failed turns never expose stale follow-ups', () => {
  const old = [user(), suggested(), answer()];
  for (const status of ['submitted', 'streaming', 'error', 'resuming']) assert.deepEqual(latestChatSuggestions(old, status), []);
  assert.deepEqual(latestChatSuggestions([...old, user()], 'ready'), []);
  assert.deepEqual(latestChatSuggestions([...old, user(), answer()], 'ready'), []);
});

test('latest clear, malformed or incomplete suggestion overrides old choices', () => {
  const old = [user(), suggested()];
  for (const newer of [suggested([]), suggested([{ label: 'Missing prompt' }]), suggested(choices, 'output-error'), suggested(choices, 'input-available')]) {
    assert.deepEqual(latestChatSuggestions([...old, newer, answer()], 'ready'), []);
  }
});

test('static tool parts work and duplicated prompts produce one button', () => {
  const message = suggested([...choices, ...choices]);
  message.parts[0].type = 'tool-suggest_next_steps';
  delete message.parts[0].toolName;
  assert.deepEqual(latestChatSuggestions([user(), message, answer()], 'ready'), choices);
});

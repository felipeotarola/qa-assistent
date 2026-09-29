import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentSchema } from '../shared/workspace.ts';
import { z } from 'zod';

const graph = () => ({ kind: 'diagram', nodes: [{ id: 'home', label: 'Home' }, { id: 'docs', label: 'Docs', url: 'https://example.com/docs' }], edges: [{ id: 'link', source: 'home', target: 'docs' }] });
test('workspace diagrams default unverified edges to inferred and support agent JSON schema', () => {
  const content = contentSchema.parse(graph());
  assert.equal(content.edges[0].status, 'inferred');
  assert.deepEqual(content.sources, []);
  assert.doesNotThrow(() => z.toJSONSchema(contentSchema));
});
test('diagram relationships need valid unique references and evidence before verification', () => {
  for (const change of [
    g => g.nodes.push(g.nodes[0]),
    g => g.edges.push(g.edges[0]),
    g => g.edges[0].target = 'missing',
    g => g.edges[0].status = 'verified',
    g => g.nodes[0].url = 'javascript:alert(1)',
    g => g.nodes[0].url = 'https://user:secret@example.com',
  ]) {
    const value = graph(); change(value);
    assert.equal(contentSchema.safeParse(value).success, false);
  }
  const value = graph();
  value.edges[0] = { ...value.edges[0], status: 'verified', evidence: 'Observed header link on https://example.com on 2026-09-29' };
  assert.equal(contentSchema.safeParse(value).success, true);
});

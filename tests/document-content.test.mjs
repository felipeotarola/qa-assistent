import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentSchema, imageReferences, documentText } from '../shared/workspace.ts';
import { documentMarkdown } from '../shared/document-markdown.ts';

test('legacy pipe tables display as Markdown without changing valid tables or code', () => {
  const legacy = '## Tests\n\nID | Result\nA | Pass\nB | Fail';
  assert.equal(documentMarkdown(legacy), '## Tests\n\nID | Result\n--- | ---\nA | Pass\nB | Fail');
  const valid = '| ID | Result |\n| --- | --- |\n| A | Pass |';
  assert.equal(documentMarkdown(valid), valid);
  const code = '```text\n' + legacy + '\n```';
  assert.equal(documentMarkdown(code), code);
  assert.equal(documentMarkdown('a | b\nc | d | e\nf | g'), 'a | b\nc | d | e\nf | g');
});
test('mixed documents validate nested tables and retain image references and searchable data', () => {
  const image = { kind: 'image', itemId: '12345678-1234-4234-8234-123456789012', caption: 'Screenshot' };
  const blocks = [{ kind: 'heading', text: 'Tests' }, { kind: 'table', columns: ['Name', 'Evidence'], rows: [['Login', image]] }, { kind: 'chart', chartType: 'bar', title: 'Results', data: [{ label: 'Pass', value: 3 }] }];
  const content = contentSchema.parse({ kind: 'text', text: '', blocks });
  assert.deepEqual(imageReferences(content), [image]);
  assert.match(documentText(blocks), /Login \| Screenshot/);
  assert.match(documentText(blocks), /Pass: 3/);
  assert.equal(contentSchema.safeParse({ kind: 'text', text: '', blocks: [{ kind: 'table', columns: ['Name'], rows: [['too', 'many']] }] }).success, false);
  assert.equal(contentSchema.safeParse({ kind: 'text', text: '', blocks: [{ kind: 'chart', chartType: 'bar', title: '', data: [{ label: 'bad', value: -1 }] }] }).success, false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertWorkspaceImage } from '../shared/insert-workspace-image.ts';
const image = { kind: 'image', itemId: '12345678-1234-4234-8234-123456789012', caption: 'Example' };
test('inserts into documents without losing text or mutating the original', () => {
  const source = { kind: 'text', text: 'Original text' };
  const result = insertWorkspaceImage(source, image, { kind: 'document', index: 1 });
  assert.deepEqual(result.blocks, [{ kind: 'text', text: source.text }, image]);
  assert.equal(source.blocks, undefined);
  assert.throws(() => insertWorkspaceImage(source, image, { kind: 'document', index: 3 }));
});
test('table replacement is explicit and scoped to the selected cell', () => {
  const table = { kind: 'table', columns: ['A', 'B'], rows: [['existing', '']] };
  assert.throws(() => insertWorkspaceImage(table, image, { kind: 'cell', row: 0, column: 0 }), /occupied/);
  const inserted = insertWorkspaceImage(table, image, { kind: 'cell', row: 0, column: 1 });
  assert.deepEqual(inserted.rows, [['existing', image]]);
  assert.deepEqual(insertWorkspaceImage(table, image, { kind: 'cell', row: 0, column: 0 }, true).rows, [[image, '']]);
  assert.deepEqual(table.rows, [['existing', '']]);
  assert.throws(() => insertWorkspaceImage(table, image, { kind: 'cell', row: -1, column: 0 }));
});
test('supports tables inside documents and preserves surrounding blocks', () => {
  const source = { kind: 'text', text: '', blocks: [{ kind: 'heading', text: 'Heading' }, { kind: 'table', columns: ['Image'], rows: [['']] }] };
  const result = insertWorkspaceImage(source, image, { kind: 'cell', blockIndex: 1, row: 0, column: 0 });
  assert.deepEqual(result.blocks[0], source.blocks[0]);
  assert.deepEqual(result.blocks[1].rows, [[image]]);
  assert.throws(() => insertWorkspaceImage(source, image, { kind: 'cell', blockIndex: 0, row: 0, column: 0 }));
});

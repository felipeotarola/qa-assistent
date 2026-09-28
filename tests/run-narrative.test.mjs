import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNarrative } from '../shared/run-narrative.ts';
test('legacy inline steps become separate markdown list items without rewriting observations', () => {
  assert.equal(runNarrative('Resultat: (1) Öppnade sidan. (2) Skickade formuläret. (3) Ett fel visades.'), 'Resultat:\n\n1. Öppnade sidan.\n\n2. Skickade formuläret.\n\n3. Ett fel visades.');
  assert.equal(runNarrative('Ett fel (kan vara avsiktligt) visades.'),'Ett fel (kan vara avsiktligt) visades.');
  assert.equal(runNarrative('## Utfall\n\n- Godkänt\n- Ingen omdirigering'),'## Utfall\n\n- Godkänt\n- Ingen omdirigering');
});

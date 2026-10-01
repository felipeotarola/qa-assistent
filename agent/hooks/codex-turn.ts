import { defineHook } from 'eve/hooks';
import { codexTurn } from '../lib/codex-turn';

export default defineHook({ events: {
  'turn.started': () => { codexTurn.update(() => ({ turnId: '' })); },
} });

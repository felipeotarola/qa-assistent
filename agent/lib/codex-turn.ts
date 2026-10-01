import { defineState } from 'eve/context';

// Durable, turn-scoped handoff: the next user message has a different turn ID.
// Never use a global/module boolean: sessions and users must remain independent.
export const codexTurn = defineState('qaa.codex-handoff', () => ({ turnId: '' }));

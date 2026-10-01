import { toolDetails, type ToolDetail } from './tool-details.ts';
/** UI projection only. Durable messages and workspace objects remain authoritative. */
export interface ActivityStep {
  id: string;
  actorId: string;
  parentId?: string;
  label: string;
  kind?: 'tool' | 'reasoning';
  input?: ToolDetail[];
  output?: ToolDetail[];
  status: 'working' | 'waiting' | 'done' | 'error' | 'unconfirmed';
  item?: { id: string; title: string; kind: string };
}
export interface ActivitySnapshot {
  threadId: string;
  workspaceId: string | null;
  turnId: string;
  busy: boolean;
  connected: boolean;
  failed: boolean;
  steps: ActivityStep[];
  texts: { id: string; text: string }[];
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}
const names: Record<string, string> = { bash: 'Kommandokörning', browser: 'Webbläsare', workspace: 'Material', research: 'Undersökning', web_search: 'Webbsökning', test_run: 'Testkörning', test_plan: 'Testplan', test_requirement: 'Krav', ask_question: 'Fråga till dig' };
const actions: Record<string, string> = { read: 'Läser', list: 'Hämtar lista', create: 'Skapar', update: 'Uppdaterar', screenshot: 'Tar skärmbild', save_file: 'Sparar fil', start: 'Startar', finish: 'Registrerar resultat', open: 'Öppnar', inspect: 'Inspekterar', click: 'Klickar', navigate: 'Navigerar' };
export function projectActivity(messages: readonly { id: string; role: string; parts: readonly unknown[] }[], busy: boolean): Pick<ActivitySnapshot, 'turnId' | 'steps' | 'texts'> {
  const start = messages.findLastIndex(message => message.role === 'user');
  const current = messages.slice(Math.max(0, start));
  const steps = new Map<string, ActivityStep>();
  const texts: ActivitySnapshot['texts'] = [];
  for (const message of current) {
    if (message.role !== 'assistant') continue;
    for (const [index, raw] of message.parts.entries()) {
      const part = record(raw);
      if (part.type === 'reasoning') {
        const active = busy && part.state === 'streaming';
        const id = `${message.id}:reasoning:${index}`;
        steps.set(id, { id, actorId: 'main', kind: 'reasoning', label: active ? 'Analyserar uppgiften' : 'Analyssteg', status: active ? 'working' : part.state === 'done' ? 'done' : 'unconfirmed' });
      }
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) texts.push({ id: `${message.id}:${index}`, text: part.text });
      if (typeof part.type !== 'string' || !(part.type === 'dynamic-tool' || part.type.startsWith('tool-'))) continue;
      const name = part.type === 'dynamic-tool' ? String(part.toolName ?? '') : part.type.slice(5);
      if (name === 'suggest_next_steps') continue;
      const input = record(part.input), output = record(part.output);
      const id = `${message.id}:${String(part.toolCallId ?? index)}`;
      const waiting = part.state === 'approval-requested' || (name === 'ask_question' && part.state !== 'output-available');
      const status = part.state === 'output-error' || part.state === 'output-denied' || output.error || output.isError === true ? 'error'
        : part.state === 'output-available' ? 'done' : waiting ? 'waiting' : busy ? 'working' : 'unconfirmed';
      const item = record(output.item), content = record(item.content);
      const saved = name === 'workspace' && ['create', 'update', 'save_file', 'screenshot'].includes(String(input.action)) && status === 'done';
      steps.set(id, { id, actorId: 'main', kind: 'tool', input: toolDetails(part.input), output: toolDetails(part.errorText ? { errorText: part.errorText } : part.output), label: `${names[name] ?? name.replaceAll('__', ' · ').replaceAll('_', ' ')}${typeof input.action === 'string' ? ` · ${actions[input.action] ?? input.action}` : ''}`, status,
        ...(saved && typeof item.id === 'string' && typeof item.title === 'string' ? { item: { id: item.id, title: item.title, kind: String(content.kind ?? '') } } : {}) });
      if (name === 'test_run' && status === 'done' && typeof output.itemId === 'string' && typeof output.id === 'string') {
        steps.get(id)!.item = { id: output.itemId, title: `Testkörning · ${String(record(output.snapshot).title ?? output.caseId ?? '')}`, kind: 'test_plan' };
      }
    }
  }
  return { turnId: current[0]?.id ?? '', steps: [...steps.values()], texts };
}

import { defaultMessageReducer } from "eve/client";
import type { MessageStreamEvent, EveMessage } from "eve/client";

export interface ArchivedMessage { sessionId: string; at: string; message: EveMessage }
export interface ChatHistorySnapshot {
  messages: ArchivedMessage[];
  cursors: { sessionId: string; eventId: string }[];
  sessionId?: string | null;
  acceptedMessageIds?: string[];
}
export const archivedEventTypes = new Set([
  "session.started", "turn.started", "message.received", "message.completed", "reasoning.completed",
  "actions.requested", "action.result", "step.started", "step.completed", "step.failed",
  "turn.completed", "turn.failed", "turn.cancelled", "session.waiting", "session.completed", "session.failed", "result.completed",
]);

export function projectChatHistory(rows: { sessionId: string; event: MessageStreamEvent }[]): ArchivedMessage[] {
  const sessions = new Map<string, MessageStreamEvent[]>();
  for (const row of rows) {
    const events = sessions.get(row.sessionId) ?? [];
    events.push(row.event); sessions.set(row.sessionId, events);
  }
  const result: ArchivedMessage[] = [];
  for (const [sessionId, events] of sessions) {
    // Older root-agent copies inherited the archive hook. Preserve the records
    // but never project their private delegation prompts as user chat turns.
    if (events.some(event => event.type === 'session.started' && event.data.invocation?.kind === 'subagent')) continue;
    const reducer = defaultMessageReducer();
    let data = reducer.initial();
    const times = new Map<string, string>();
    for (const event of events.sort((a, b) => a.meta.id.localeCompare(b.meta.id))) {
      data = reducer.reduce(data, event);
      const turnId = "data" in event && "turnId" in event.data ? event.data.turnId : undefined;
      if (typeof turnId === "string" && !times.has(turnId)) times.set(turnId, event.meta.at);
    }
    for (const message of data.messages) result.push({ sessionId, at: times.get(message.metadata?.turnId ?? "") ?? events[0]!.meta.at, message });
  }
  return result.sort((a, b) => a.at.localeCompare(b.at) || (a.message.role === b.message.role ? 0 : a.message.role === "user" ? -1 : 1));
}

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

const id = z.string().min(1).max(400);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const priorUserMessageIdsSchema = z.array(id).max(8)
  .refine(values => new Set(values).size === values.length, 'Duplicate user message references').default([]);
export const missionRequestContextSchema = z.object({
  sessionId: id, turnId: id, nonce: z.string().uuid(), runtime: z.string().min(1).max(300),
  priorUserMessageIds: priorUserMessageIdsSchema,
}).strict();
export type MissionRequestContext = z.infer<typeof missionRequestContextSchema>;
const markerSchema = z.object({ version: z.literal(1), nonce: z.string().uuid(), textSha256: digest }).strict();
const provenanceSchema = markerSchema.extend({
  userId: z.string().uuid(), threadId: z.string().uuid(), sessionId: id,
  runtime: z.string().min(1).max(300), turnId: id,
}).strict();
export const userTextHash = (text: string) => createHash('sha256').update(text).digest('hex');

/** File metadata is not user-authored request text. Preserve all text parts. */
export function userMessageText(message: unknown): string | null {
  if (typeof message === 'string') return message.length ? message : null;
  if (!Array.isArray(message) || !message.length) return null;
  const text: string[] = [];
  for (const part of message) {
    if (!part || typeof part !== 'object') return null;
    if (part.type === 'text') {
      if (typeof part.text !== 'string' || !part.text.length) return null;
      text.push(part.text);
    } else if (part.type !== 'file') return null;
  }
  return text.length ? text.join('\n') : null;
}

/** Called only by the authenticated public Eve HTTP channel, never a tool. */
export async function browserUserInputMarker(request: Request): Promise<string> {
  if (request.method !== 'POST' || !/^\/eve\/v1\/session(?:\/[^/]+)?\/?$/.test(new URL(request.url).pathname)) return '';
  let body;
  try { body = await request.clone().json(); } catch { return ''; }
  if (!body || typeof body !== 'object' || body.inputResponses !== undefined) return '';
  const text = userMessageText(body.message);
  return text?.trim() ? JSON.stringify({ version: 1, nonce: randomUUID(), textSha256: userTextHash(text) }) : '';
}

export function browserInputMarker(attributes: Record<string, unknown>) {
  if (attributes.browserWorker || attributes.browserNotification || attributes.setupNotification || attributes.resultReviewNotification) return null;
  if (typeof attributes.browserUserInput !== 'string') return null;
  try {
    const value = markerSchema.safeParse(JSON.parse(attributes.browserUserInput));
    return value.success ? value.data : null;
  } catch { return null; }
}

type Event = { type: string; data?: unknown; meta: { id: string; at: string } };
export type RequestMessageRow = { id: string; sessionId: string; runtime: string; event: Event };
type Identity = { userId: string; threadId: string; sessionId: string; runtime: string; turnId: string };

export function stampUserRequest(event: Event, identity: Identity, attributes: Record<string, unknown>) {
  const marker = browserInputMarker(attributes);
  if (event.type !== 'message.received' || !marker || !event.data || typeof event.data !== 'object') return null;
  const data = event.data as Record<string, unknown>;
  const text = userMessageText(data.parts ?? data.message);
  if (data.turnId !== identity.turnId || text === null || userTextHash(text) !== marker.textSha256) return null;
  return provenanceSchema.parse({ ...marker, ...identity });
}

export function trustedRequestMessage(row: RequestMessageRow, userId: string, threadId: string) {
  if (row.event.type !== 'message.received' || !row.event.data || typeof row.event.data !== 'object') return null;
  const data = row.event.data as Record<string, unknown>;
  const parsed = provenanceSchema.safeParse(data.userRequest);
  const text = userMessageText(data.parts ?? data.message);
  if (!parsed.success || text === null) return null;
  const source = parsed.data;
  if (source.userId !== userId || source.threadId !== threadId || source.sessionId !== row.sessionId
    || source.runtime !== row.runtime || source.turnId !== data.turnId || source.textSha256 !== userTextHash(text)
    || !Number.isSafeInteger(data.sequence) || Number(data.sequence) < 0 || !Number.isFinite(Date.parse(row.event.meta.at))) return null;
  return { id: row.id, text, source, sequence: Number(data.sequence), at: row.event.meta.at };
}

export function bindMissionRequest(rows: RequestMessageRow[], userId: string, threadId: string, value: MissionRequestContext) {
  const context = missionRequestContextSchema.parse(value);
  const messages = rows.flatMap(row => {
    const message = trustedRequestMessage(row, userId, threadId);
    return message ? [message] : [];
  });
  const matches = messages.filter(message => message.source.sessionId === context.sessionId
    && message.source.turnId === context.turnId && message.source.runtime === context.runtime);
  // Durable replay repeats the same event ID. Multiple original receipts are not guessed apart.
  if (matches.length !== 1 || matches[0]!.source.nonce !== context.nonce) throw new Error('The current authenticated user message is unavailable or ambiguous.');
  const current = matches[0]!;
  const prior = context.priorUserMessageIds.map(id => {
    const message = messages.find(message => message.id === id);
    if (!message || message.id === current.id || Date.parse(message.at) >= Date.parse(current.at)
      || (message.source.sessionId === current.source.sessionId && message.sequence >= current.sequence)) {
      throw new Error('A prior user message is unavailable or is not earlier in this chat.');
    }
    return message;
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  const goal = prior.length
    ? `Tidigare användarmeddelanden (kravkontext, inte ny tillåtelse att utföra äldre uppdrag):\n${prior.map(message => message.text).join('\n')}\nAktuellt användarmeddelande:\n${current.text}`
    : current.text;
  if (!goal.trim() || goal.length > 10000) throw new Error('The full request and its selected context must fit 10000 characters.');
  const reference = (message: typeof current) => ({ eventId: message.id, sessionId: message.source.sessionId,
    turnId: message.source.turnId, runtime: message.source.runtime, nonce: message.source.nonce, textSha256: message.source.textSha256 });
  return { goal, source: { version: 1 as const, current: reference(current), prior: prior.map(reference), goalSha256: userTextHash(goal) } };
}
export type MissionRequestSource = ReturnType<typeof bindMissionRequest>['source'];

/** Recovery reconnects only; it never submits another turn. */
export function chatFailureMessage(error: unknown): string {
  const value = error as { status?: number; statusCode?: number; message?: string } | undefined;
  const code = value?.statusCode ?? value?.status;
  if (code === 401 || code === 403) return "Din inloggning behöver förnyas. Logga in igen och öppna chatten.";
  if (code === 404 || code === 409) return "Chattsessionen kunde inte öppnas. Hämta senaste status innan du fortsätter.";
  return "Anslutningen eller agentens körning avbröts. Arbete kan redan ha utförts. Hämta senaste status innan du skickar igen.";
}
export function draftKey(chatId: string, kind: "draft" | "outgoing" | "attempt") { return `pat-chat:${chatId}:${kind}`; }
export const CHAT_MESSAGE_HEADER = 'x-pat-message-id';
export interface OutgoingAttempt { id: string; text: string; phase: 'waiting' | 'sent' }
export function readOutgoingAttempt(raw: string | null, text: string): OutgoingAttempt | null {
  try {
    const value = JSON.parse(raw ?? 'null');
    return value && /^[a-f0-9-]{36}$/i.test(value.id) && value.text === text && ['waiting', 'sent'].includes(value.phase) ? value : null;
  } catch { return null; }
}

/** Only durable receipts count. Optimistic UI messages are not acknowledgements. */
export function outgoingAcknowledged(text: string, attempt: OutgoingAttempt | null, history: {
  acceptedMessageIds?: string[];
  messages: { message: { role: string; parts: readonly { type: string; text?: string }[] } }[];
}) {
  if (!text) return false;
  if (attempt) return attempt.phase === 'sent' && !!history.acceptedMessageIds?.includes(attempt.id);
  // One-time migration for the old text-only storage format. Keep any composer
  // draft intact; only retire text already preserved in this chat's archive.
  // Old copies could survive several later turns, not just the latest turn.
  return history.messages.some(row => row.message.role === 'user' && row.message.parts.filter(part => part.type === 'text').map(part => part.text).join('') === text);
}

/** Recovery reconnects only; it never submits another turn. */
export function chatFailureMessage(error: unknown): string {
  const value = error as { status?: number; statusCode?: number; message?: string } | undefined;
  const code = value?.statusCode ?? value?.status;
  if (code === 401 || code === 403) return "Din inloggning behöver förnyas. Logga in igen och öppna chatten.";
  if (code === 404 || code === 409) return "Chattsessionen kunde inte öppnas. Hämta senaste status innan du fortsätter.";
  return "Anslutningen eller agentens körning avbröts. Arbete kan redan ha utförts. Hämta senaste status innan du skickar igen.";
}
export function draftKey(chatId: string, kind: "draft" | "outgoing") { return `pat-chat:${chatId}:${kind}`; }

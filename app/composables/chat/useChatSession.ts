import type { UIMessage } from "ai";
import type { ThreadRecord } from "#shared/types/thread";
import type { AgentInputResponse } from "~/components/AgentInputRequest.vue";
import { recordAuthorizationEvent } from "~/composables/chat/useAuthorizationChallenges";
import { resumeOptionsFromThread } from "~/composables/chat/thread-session";
import { refreshThreadList } from "~/composables/chat/navigation";
import { recordStreamEvent } from "~/composables/chat/stream-log";
import { clearTurnFailure, recordTurnFailure, turnFailure } from "~/composables/chat/turn-errors";
import { CHAT_MODEL_HEADER, REASONING_HEADER } from "#shared/chat-models";
import { BROWSER_THREAD_HEADER } from "#shared/browser";
import type { ArchivedMessage, ChatHistorySnapshot } from "#shared/chat-history";
import { draftKey } from "#shared/chat-recovery";

/** The four statuses the Nuxt UI chat components understand. */
export type ChatStatus = "ready" | "submitted" | "streaming" | "error";

/**
 * Binds one durable eve session to one thread, for the lifetime of the page.
 *
 * `useEveAgent` attaches to the calling component's scope, so this must run in
 * setup and the agent must not outlive it — the thread's stored session id is
 * what carries the conversation across visits.
 */
export function useChatSession(thread: ThreadRecord) {
  const chatId = thread.id;
  const initial = resumeOptionsFromThread(thread);
  const selectedModel = useChatModel();
  const selectedReasoning = useChatReasoning();
  const archived = ref<ArchivedMessage[]>(thread.history ?? []);
  const persistenceError = ref<Error>();
  const actionError = ref<Error>();
  const sending = ref(false);
  const savedText = ref("");
  function saveOutgoing(text: string) {
    savedText.value = text;
    try { if (import.meta.client) { if (text) sessionStorage.setItem(draftKey(chatId, "outgoing"), text); else sessionStorage.removeItem(draftKey(chatId, "outgoing")); } } catch { /* Keep the in-memory copy if storage is unavailable. */ }
  }
  onMounted(() => { try { savedText.value = sessionStorage.getItem(draftKey(chatId, "outgoing")) ?? ""; } catch { /* Storage may be disabled. */ } });
  let boundSession = thread.sessionId;
  const { workers } = useAgentActivity();
  workers.value = [];
  onBeforeUnmount(() => { workers.value = workers.value.filter(worker => worker.threadId !== chatId); });

  const agent = useEveAgent({
    ...initial,
    headers: () => ({
      [BROWSER_THREAD_HEADER]: chatId,
      [CHAT_MODEL_HEADER]: selectedModel.value,
      [REASONING_HEADER]: selectedReasoning.value,
    }),
    onSessionChange: (session) => {
      // The server hook binds the runtime, even if this browser disconnects.
      if (session && session.sessionId !== boundSession) {
        boundSession = session.sessionId;
        void refreshThreadList();
      }
    },
    onEvent: (event) => {
      if (event.type === 'turn.started') workers.value = [];
      if (event.type === 'subagent.called' && event.data.childSessionId && !workers.value.some(worker => worker.sessionId === event.data.childSessionId) && workers.value.length < 8) {
        workers.value.push({ threadId: chatId, sessionId: event.data.childSessionId, name: event.data.toolName, callId: event.data.callId });
      }
      if (event.type === "authorization.required" || event.type === "authorization.completed") {
        recordAuthorizationEvent(event);
      }

      if (event.type === "turn.failed" || event.type === "session.failed") {
        recordTurnFailure(chatId, event);
      }

      if (import.meta.dev) recordStreamEvent(event.type);
    },
  });

  // Text held while a send waits for a replay to finish. eve only projects a
  // user message once the turn is handed over, so it is shown here instead —
  // in the transcript, where a sent message belongs.
  const queued = ref<string>();

  let disposed = false;
  let reconnecting = false;
  let historyTimer: ReturnType<typeof setTimeout> | undefined;
  async function refreshHistory() {
    try {
      const data = await $fetch<ChatHistorySnapshot>(`/api/threads/${chatId}/history`);
      if (!disposed) {
        // Do not invalidate the full transcript for unchanged polling responses.
        if (JSON.stringify(archived.value) !== JSON.stringify(data.messages)) archived.value = data.messages;
        if (persistenceError.value?.message === "Kunde inte uppdatera den gemensamma chatthistoriken.") persistenceError.value = undefined;
        // A settled stream can miss a later turn started in another tab, or
        // during a reconnect. Catch up from Eve; never resend the user's action.
        const sessionId = agent.session.value?.sessionId;
        const cursor = data.cursors.find(item => item.sessionId === sessionId);
        const lastEvent = agent.events.value.at(-1)?.meta.id;
        if (!reconnecting && !sending.value && agent.status.value === 'ready' && cursor && (!lastEvent || cursor.eventId > lastEvent)) {
          reconnecting = true;
          void agent.resume().catch(() => { /* Eve exposes the transport error. */ }).finally(() => { reconnecting = false; });
        }
      }
    }
    catch { if (!disposed) persistenceError.value = new Error("Kunde inte uppdatera den gemensamma chatthistoriken."); }
  }
  async function pollHistory() { await refreshHistory(); if (!disposed) historyTimer = setTimeout(pollHistory, 5000); }
  onMounted(() => { void pollHistory(); });
  onBeforeUnmount(() => { disposed = true; clearTimeout(historyTimer); });
  const liveTimes = new Map<string, string>();

  const messages = computed(() => {
    const merged = new Map(archived.value.map(row => [`${row.sessionId}:${row.message.id}`, row]));
    const sessionId = agent.session.value?.sessionId ?? thread.sessionId ?? "pending";
    for (const message of agent.data.value.messages) {
      const key = `${sessionId}:${message.id}`;
      const at = merged.get(key)?.at ?? liveTimes.get(message.metadata?.turnId ?? key) ?? new Date().toISOString();
      liveTimes.set(message.metadata?.turnId ?? key, at);
      merged.set(key, { sessionId, at, message });
    }
    const sent = [...merged.entries()].sort(([, a], [, b]) => a.at.localeCompare(b.at) || (a.message.role === b.message.role ? 0 : a.message.role === "user" ? -1 : 1)).map(([id, row]) => ({ ...row.message, id })) as UIMessage[];
    if (!queued.value) return sent;

    return [...sent, {
      id: `pending:${chatId}`,
      role: "user",
      parts: [{ type: "text", text: queued.value }],
    } as UIMessage];
  });

  const status = computed<ChatStatus>(() => {
    if (queued.value !== undefined) return "submitted";
    // Replaying a stored session is not an in-flight turn.
    return agent.status.value === "resuming" ? "ready" : agent.status.value;
  });

  const error = computed(() => {
    if (actionError.value) return actionError.value;
    if (persistenceError.value) return persistenceError.value;
    if (agent.error.value) return agent.error.value;
    const failure = turnFailure(chatId);
    return failure ? new Error(failure) : undefined;
  });

  // A replay can accept one queued message through whenSendable. Blocking the
  // composer here made that path unreachable after opening an existing chat.
  const isBusy = computed(() => sending.value || status.value === "submitted" || status.value === "streaming");
  const chatActivity = useState<Record<string, boolean>>('chat-activity', () => ({}));
  watch(isBusy, value => { chatActivity.value[chatId] = value; }, { immediate: true });
  onBeforeUnmount(() => { chatActivity.value = Object.fromEntries(Object.entries(chatActivity.value).filter(([id]) => id !== chatId)); });

  /** eve rejects sends while a session replays; wait rather than drop them. */
  async function whenSendable(text?: string) {
    if (agent.status.value !== "resuming") return;

    queued.value = text ?? "";
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { stop(); reject(new Error("Det tog för lång tid att återansluta till chatten.")); }, 30000);
        const stop = watch(agent.status, (value) => {
          if (value === "resuming") return;
          clearTimeout(timer);
          stop();
          resolve();
        });
      });
    }
    finally {
      queued.value = undefined;
    }
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending.value) return;
    if (savedText.value) {
      actionError.value = new Error("Kontrollera den sparade texten innan du skickar ett nytt meddelande.");
      return;
    }
    sending.value = true;
    saveOutgoing(trimmed);
    actionError.value = undefined;
    clearTurnFailure(chatId);
    try {
      if (persistenceError.value) throw persistenceError.value;
      await whenSendable(trimmed);
      await agent.send(trimmed);
      if (!agent.error.value && !turnFailure(chatId)) saveOutgoing("");
    } catch (cause) { actionError.value = cause instanceof Error ? cause : new Error("Meddelandet kunde inte skickas"); }
    finally { sending.value = false; }
  }

  async function respond(responses: AgentInputResponse[]) {
    try {
      clearTurnFailure(chatId);
      await whenSendable();
      await agent.respond(responses);
    } catch (cause) { actionError.value = cause instanceof Error ? cause : new Error("Svaret kunde inte skickas"); }
  }

  // Reload re-fetches the authoritative runtime binding and replays its stream.
  // Never resend the previous message: a lost response can hide a successful write.
  function retry() { if (import.meta.client) window.location.reload(); }
  function dismissSavedText() { saveOutgoing(""); actionError.value = undefined; }
  async function cancel() {
    try { await agent.cancel(); }
    catch (cause) { actionError.value = cause instanceof Error ? cause : new Error("Kunde inte bekräfta att agenten stoppats"); }
  }

  const browserResume = useState<{ threadId: string; sessionId: string } | null>("browser-resume", () => null);
  watch([browserResume, status], ([resume, currentStatus]) => {
    if (!resume || resume.threadId !== chatId || !["ready", "error"].includes(currentStatus)) return;
    browserResume.value = null;
    void send(`Jag har lämnat tillbaka kontrollen över webbläsarsession ${resume.sessionId}. Läs av just den sessionen med browser sessionId och fortsätt med uppgiften.`);
  });

  return {
    selectedModel,
    selectedReasoning,
    messages,
    status,
    error,
    isBusy,
    send,
    respond,
    retry,
    cancel,
    savedText,
    dismissSavedText,
  };
}

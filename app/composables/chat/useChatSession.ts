import type { EveMessageData } from "eve/vue";
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
import type { ArchivedMessage } from "#shared/chat-history";

/** The four statuses the Nuxt UI chat components understand. */
export type ChatStatus = "ready" | "submitted" | "streaming" | "error";

function lastUserMessageText(data: EveMessageData) {
  for (let index = data.messages.length - 1; index >= 0; index -= 1) {
    const message = data.messages[index];
    if (message?.role !== "user") continue;

    const text = message.parts
      .filter(part => part.type === "text")
      .map(part => part.text)
      .join("\n")
      .trim();

    if (text) return text;
  }
}

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
  let boundSession = thread.sessionId;

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
  let historyTimer: ReturnType<typeof setTimeout> | undefined;
  async function refreshHistory() {
    try {
      const data = await $fetch<{ messages: ArchivedMessage[] }>(`/api/threads/${chatId}/history`);
      if (!disposed) {
        archived.value = data.messages;
        if (persistenceError.value?.message === "Kunde inte uppdatera den gemensamma chatthistoriken.") persistenceError.value = undefined;
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
    if (persistenceError.value) return persistenceError.value;
    if (agent.error.value) return agent.error.value;
    const failure = turnFailure(chatId);
    return failure ? new Error(failure) : undefined;
  });

  const isBusy = computed(() => status.value === "submitted" || status.value === "streaming");

  /** eve rejects sends while a session replays; wait rather than drop them. */
  async function whenSendable(text?: string) {
    if (agent.status.value !== "resuming") return;

    queued.value = text ?? "";
    try {
      await new Promise<void>((resolve) => {
        const stop = watch(agent.status, (value) => {
          if (value === "resuming") return;
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
    if (!trimmed) return;

    clearTurnFailure(chatId);
    if (persistenceError.value) throw persistenceError.value;
    await whenSendable(trimmed);
    await agent.send(trimmed);
  }

  async function respond(responses: AgentInputResponse[]) {
    clearTurnFailure(chatId);
    await whenSendable();
    await agent.respond(responses);
  }

  async function retry() {
    if (isBusy.value) return;

    const text = lastUserMessageText(agent.data.value);
    if (!text) return;

    clearTurnFailure(chatId);
    await whenSendable(text);
    await agent.send(text);
  }

  const browserResume = useState<string | null>("browser-resume", () => null);
  watch([browserResume, status], ([threadId, currentStatus]) => {
    if (threadId !== chatId || !["ready", "error"].includes(currentStatus)) return;
    browserResume.value = null;
    void send("Jag har lämnat tillbaka kontrollen över webbläsaren. Läs av sidan igen och fortsätt med uppgiften.");
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
    cancel: agent.cancel,
  };
}

import type { MaybeRefOrGetter } from "vue";
import { toValue } from "vue";
import type { ThreadRecord, ThreadSummary } from "#shared/types/thread";
import { resetStreamLog } from "~/composables/chat/stream-log";
import { truncateThreadTitle } from "#shared/types/thread";
import { clearCachedPayloadData } from "~/utils/payload-cache";
import { DEFAULT_CHAT_MODEL, DEFAULT_REASONING } from '#shared/chat-models';

type PendingMessage = {
  chatId: string;
  text: string;
};

let pendingMessage: PendingMessage | null = null;

export const THREAD_LIST_KEY = "thread-list";

interface ThreadListResponse {
  threads: ThreadSummary[];
}

function upsertThreadInListCache(thread: ThreadSummary) {
  if (!import.meta.client) {
    return;
  }

  const nuxtApp = useNuxtApp();
  const cached = nuxtApp.payload.data[THREAD_LIST_KEY] as ThreadListResponse | undefined;
  const threads = cached?.threads ?? [];
  nuxtApp.payload.data[THREAD_LIST_KEY] = {
    threads: [thread, ...threads.filter(entry => entry.id !== thread.id)],
  };
}

export async function refreshThreadList() {
  clearCachedPayloadData(THREAD_LIST_KEY);
  await refreshNuxtData(THREAD_LIST_KEY);
}

export async function startChat(message: string, chatId = crypto.randomUUID()) {
  const workspaceId = useCookie<string | null>("pat_workspace").value;
  const text = message.trim();
  if (!text) return;

  const { thread } = await $fetch<{ thread: ThreadRecord }>("/api/threads", {
    method: "POST",
    body: {
      id: chatId,
      title: truncateThreadTitle(text),
      workspaceId: workspaceId || undefined,
    },
  });

  upsertThreadInListCache(thread);
  pendingMessage = { chatId, text };
  await refreshThreadList();
  // Nuxt owns the view transition. Starting another here cancels it and can
  // reject navigation even though the new chat has already been created.
  await navigateTo(`/chat/${chatId}`);
}

export function consumePendingMessage(chatId: string) {
  if (pendingMessage?.chatId !== chatId) return null;

  const text = pendingMessage.text;
  pendingMessage = null;
  return text;
}

export async function startNewChat() {
  pendingMessage = null;
  resetStreamLog();
  useChatModel().value = DEFAULT_CHAT_MODEL;
  useChatReasoning().value = DEFAULT_REASONING;
  await navigateTo("/");
}

export function useChatNavigation(chatId: MaybeRefOrGetter<string>) {
  function consumePendingOnMount(sendMessage: (text: string) => Promise<void>) {
    const id = toValue(chatId);
    const pending = consumePendingMessage(id);
    if (pending) {
      void sendMessage(pending);
      return true;
    }
    return false;
  }

  return {
    consumePendingOnMount,
  };
}

export async function deleteThread(id: string) {
  await $fetch(`/api/threads/${id}`, { method: "DELETE" });
  await refreshThreadList();

  const route = useRoute();
  if (route.params.id === id) {
    await startNewChat();
  }
}

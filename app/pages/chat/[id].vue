<script setup lang="ts">
import type { ThreadRecord } from "#shared/types/thread";
import { useChatNavigation, refreshThreadList } from "~/composables/chat/navigation";
import { useAuthorizationChallenges } from "~/composables/chat/useAuthorizationChallenges";
import { useStreamLog } from "~/composables/chat/stream-log";
import { useChatSession } from "~/composables/chat/useChatSession";
import { chatFailureMessage, draftKey } from "#shared/chat-recovery";
import { cardTaskPrompt } from "#shared/card-task";
import { projectActivity } from '#shared/agent-activity';
import { latestChatSuggestions } from '#shared/chat-suggestions';

const route = useRoute();
const chatId = computed(() => route.params.id as string);

// Fetched during the server render too, so the thread's durable session id is
// known before the chat session binds to it.
const requestFetch = useRequestFetch();

const { data, error, pending: resumePending } = await useAsyncData(
  () => `thread-${chatId.value}`,
  () => requestFetch<{ thread: ThreadRecord }>(`/api/threads/${chatId.value}`),
  { watch: [chatId] },
);

if (error.value || !data.value?.thread) {
  await navigateTo("/");
}

const thread = computed(() => data.value!.thread);
const workspaceBindings = useState<Record<string, string>>("thread-workspaces", () => ({}));
if (thread.value.workspaceId) workspaceBindings.value[chatId.value] = thread.value.workspaceId;

const {
  selectedModel,
  selectedReasoning,
  messages,
  status,
  error: chatError,
  isBusy,
  send,
  respond,
  cancel,
  retry,
  savedText,
  dismissSavedText,
} = useChatSession(thread.value);
const suggestions = computed(() => savedText.value || chatError.value ? [] : latestChatSuggestions(messages.value, status.value));

const activity = useAgentActivity();
watchEffect(() => {
  const latestUser = messages.value.findLast(message => message.role === 'user');
  const latestText = latestUser?.parts.filter(part => part.type === 'text').map(part => part.text).join('');
  // A failed send may never enter durable history. Do not display the previous
  // task's completed steps as if they belonged to that unconfirmed request.
  const activityMessages = savedText.value && latestText !== savedText.value
    ? [...messages.value, { id: `outgoing:${thread.value.id}`, role: 'user', parts: [] }]
    : messages.value;
  activity.snapshot.value = { ...projectActivity(activityMessages, isBusy.value), threadId: thread.value.id,
    workspaceId: thread.value.workspaceId, busy: isBusy.value, connected: true, failed: !!chatError.value || (!!savedText.value && !isBusy.value) };
});
watch(isBusy, (busy, previous) => { if (busy && !previous) activity.open.value = true; });
onBeforeUnmount(() => {
  if (activity.snapshot.value?.threadId === thread.value.id) activity.snapshot.value = null;
});

const cardAgent = useWorkspaceAgent();
const cardRunner = async (item: Parameters<typeof cardTaskPrompt>[0], text: string) => {
  if (isBusy.value || savedText.value || item.workspaceId !== thread.value.workspaceId) return false;
  await send(cardTaskPrompt(item, text));
  return !savedText.value && !chatError.value;
};
watchEffect(() => {
  cardAgent.value = { workspaceId: thread.value.workspaceId ?? "", available: !isBusy.value && !savedText.value, run: cardRunner, ask: async text => {
    if (isBusy.value || savedText.value) return false;
    await send(text);
    return !savedText.value && !chatError.value;
  } };
});
onUnmounted(() => { if (cardAgent.value?.run === cardRunner) cardAgent.value = null; });

const { consumePendingOnMount } = useChatNavigation(chatId);
const { resetTurnEventCounts } = useStreamLog();
const { pendingChallenges, failedChallenges, tryResumeConnectedChallenges } = useAuthorizationChallenges();

const input = ref("");
const recoveryMessage = computed(() => chatError.value
  ? chatFailureMessage(chatError.value)
  : "Text från ett tidigare skickförsök finns kvar. Kontrollera historiken innan du skickar den igen; arbete kan redan ha utförts.");
onMounted(() => { try { input.value = sessionStorage.getItem(draftKey(chatId.value, "draft")) ?? ""; } catch { /* Storage may be disabled. */ } });
watch(input, value => { try { sessionStorage.setItem(draftKey(chatId.value, "draft"), value); } catch { /* Keep the in-memory draft. */ } });
function restoreSavedText() {
  input.value = [input.value.trim(), savedText.value].filter(Boolean).join("\n\n");
  dismissSavedText();
  nextTick(() => promptRef.value?.textareaRef?.focus());
}
const promptRef = useTemplateRef("promptRef");
function selectSuggestion(prompt: string) {
  if (isBusy.value || savedText.value || chatError.value) return;
  input.value = input.value.trim() ? `${input.value.trim()}\n${prompt}` : prompt;
  nextTick(() => promptRef.value?.textareaRef?.focus());
}

watch(status, (value) => {
  if (value === "submitted") {
    resetTurnEventCounts();
  }
});

onMounted(() => {
  void refreshThreadList();
  void tryResumeConnectedChallenges({ skipIfBusy: isBusy.value });

  if (import.meta.client) {
    const onFocus = () => {
      void tryResumeConnectedChallenges({ skipIfBusy: isBusy.value });
    };
    window.addEventListener("focus", onFocus);
    onUnmounted(() => window.removeEventListener("focus", onFocus));
  }

  consumePendingOnMount(send);
});

function handleSubmit(e: Event) {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || isBusy.value || savedText.value) return;
  input.value = "";
  void send(text);
}

function handleInputResponses(responses: Parameters<typeof respond>[0]) {
  void respond(responses);
}
</script>

<template>
  <UDashboardPanel
    id="chat"
    class="relative min-h-0"
    :ui="{ body: 'p-0 sm:p-0 overscroll-none' }"
  >
    <template #body>
      <div
        v-if="resumePending"
        class="flex flex-1 items-center justify-center text-sm text-dimmed"
      >
        Loading chat…
      </div>

      <div
        v-else
        class="flex min-w-0 flex-1"
      >
        <UContainer class="flex min-w-0 flex-1 flex-col gap-4 px-4 sm:gap-6 sm:px-5">
          <UChatMessages
            should-auto-scroll
            :messages="messages"
            :status="status"
            :spacing-offset="160"
            :assistant="{ side: 'left', variant: 'naked', ui: { container: 'relative flex w-full min-w-0 items-start' } }"
            class="py-4 sm:py-6"
          >
            <template #indicator>
              <ChatActivityIndicator />
            </template>

            <template #content="{ message }">
              <ChatMessageContentEve
                :message="message"
                :status="status"
                :is-last="message.id === messages.at(-1)?.id"
                :can-respond="!isBusy"
                :suggestions="message.id === messages.at(-1)?.id ? suggestions : []"
                @input-responses="handleInputResponses"
                @suggestion="selectSuggestion"
              />
            </template>
          </UChatMessages>

          <div
            v-if="pendingChallenges.length || failedChallenges.length"
            class="space-y-2"
          >
            <AgentAuthorizationRequest
              v-for="challenge in pendingChallenges"
              :key="`pending-${challenge.name}`"
              :challenge="challenge"
            />
            <AgentAuthorizationRequest
              v-for="challenge in failedChallenges"
              :key="`failed-${challenge.name}`"
              :challenge="challenge"
            />
          </div>

          <UChatPrompt
            ref="promptRef"
            v-model="input"
            variant="subtle"
            class="sticky bottom-0 z-10 [view-transition-name:chat-prompt] rounded-b-none"
            :ui="{ base: 'px-1.5', footer: 'flex-wrap gap-2' }"
            @submit="handleSubmit"
          >
            <template #header>
              <ChatRecoveryNotice
                v-if="chatError || (savedText && !isBusy)"
                :message="recoveryMessage"
                :saved-text="savedText"
                @reconnect="retry()"
                @restore="restoreSavedText"
                @dismiss="dismissSavedText()"
              />
            </template>
            <template #footer>
              <div class="flex flex-wrap items-center gap-2">
                <ChatModelToggle v-model="selectedModel" :disabled="isBusy" />
                <ChatReasoningSelect v-model="selectedReasoning" :disabled="isBusy" />
              </div>
              <ChatStreamInspector :status="status" />

              <UChatPromptSubmit
                class="ms-auto shrink-0"
                :status="status"
                color="neutral"
                size="sm"
                @stop="cancel()"
                @reload="retry()"
              />
            </template>
          </UChatPrompt>
        </UContainer>
      </div>
    </template>
  </UDashboardPanel>
</template>

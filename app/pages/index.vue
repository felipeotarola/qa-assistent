<script setup lang="ts">
import HomeRecentCard from "~/components/HomeRecentCard.vue";
import { startChat } from "~/composables/chat/navigation";
import { useThreadList } from "~/composables/chat/useThreads";

const { profile } = useProfile();
const { workspaces, activeId, pending: workspacesPending, error: workspacesError, refresh: refreshWorkspaces } = useWorkspaces();
const { threads, pending, error: threadsError, refresh } = useThreadList();
const firstName = computed(() => profile.value?.name.trim().split(/\s+/)[0] || "");
const workspaceName = computed(() => workspaces.value.find(workspace => workspace.id === activeId.value)?.name);
function lastActive(timestamp: number) {
  return `Senast aktiv ${new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short', timeZone: profile.value?.timezone || 'Europe/Stockholm' }).format(timestamp)}`;
}
const recentChats = computed(() => threads.value.filter(thread => thread.workspaceId === activeId.value).sort((a, b) => b.updatedAt - a.updatedAt));
const recentWorkspaces = computed(() => workspaces.value.map(workspace => {
  const chats = threads.value.filter(thread => thread.workspaceId === workspace.id);
  return { ...workspace, count: chats.length, lastActivity: Math.max(0, ...chats.map(thread => thread.updatedAt)) };
}).sort((a, b) => b.lastActivity - a.lastActivity));
const hour = useState("home-greeting-hour", () => new Date().getHours());
onMounted(() => {
  hour.value = new Date().getHours();
  void refresh();
});

const input = ref("");
const selectedModel = useChatModel();
const selectedReasoning = useChatReasoning();

const greeting = computed(() => {
  let timeGreeting = "God kväll";
  if (hour.value < 12) timeGreeting = "God morgon";
  else if (hour.value < 18) timeGreeting = "God dag";

  return timeGreeting;
});

function createChat(prompt: string) {
  const text = prompt.trim();
  if (!text) return;
  input.value = "";
  void startChat(text);
}

function onSubmit() {
  createChat(input.value);
}

</script>

<template>
  <UDashboardPanel
    id="home"
    class="min-h-0"
    :ui="{ body: 'p-0 sm:p-0' }"
  >
    <template #body>
      <div class="flex flex-1 bg-muted/35 px-5 py-12 sm:px-8 sm:py-16">
        <div class="mx-auto my-auto flex w-full max-w-xl flex-col gap-8 sm:gap-10">
          <div class="text-center">
            <div class="mx-auto mb-5 flex size-10 items-center justify-center rounded-xl border border-default bg-default shadow-sm">
              <AppLogo class="size-4 text-highlighted" />
            </div>
            <h1 class="text-2xl font-semibold tracking-tight text-highlighted sm:text-3xl">
              {{ greeting }}{{ firstName ? `, ${firstName}` : '' }}.
            </h1>
            <p class="mt-4 text-sm leading-relaxed text-muted">
              Planera, undersök och testa tillsammans med din agent.
            </p>
            <p class="mt-1 text-xs leading-relaxed text-dimmed">{{ activeId ? `Fortsätt i ${workspaceName || 'ditt workspace'} eller starta en ny chatt.` : 'Välj ett workspace och fortsätt där du var.' }}</p>
          </div>

          <UChatPrompt
            v-if="activeId"
            v-model="input"
            class="[view-transition-name:chat-prompt] rounded-xl bg-default shadow-sm"
            placeholder="Vad vill du arbeta med?"
            variant="subtle"
            :ui="{ base: 'px-1.5', footer: 'flex-wrap gap-2' }"
            @submit="onSubmit"
          >
            <template #footer>
              <div class="flex flex-wrap items-center gap-2">
                <ChatModelToggle v-model="selectedModel" />
                <ChatReasoningSelect v-model="selectedReasoning" />
              </div>
              <UChatPromptSubmit
                class="ms-auto shrink-0"
                color="neutral"
                size="sm"
              />
            </template>
          </UChatPrompt>

          <section class="space-y-3 border-t border-default pt-5" :aria-label="activeId ? 'Dina chattar' : 'Dina workspaces'">
            <div class="flex items-center justify-between gap-3">
              <h2 class="text-xs font-semibold text-highlighted">{{ activeId ? 'Dina chattar' : 'Dina workspaces' }}</h2>
              <span v-if="!activeId" class="text-xs text-muted">Fortsätt där du var</span>
              <UButton v-if="activeId" to="/?view=workspaces" label="Alla workspaces" icon="i-lucide-layout-grid" color="neutral" variant="ghost" size="sm" />
            </div>
            <p v-if="activeId ? threadsError : workspacesError" role="alert" class="text-sm text-error">Kunde inte hämta {{ activeId ? 'chattarna' : 'workspaces' }}. <UButton label="Försök igen" variant="link" @click="activeId ? refresh() : refreshWorkspaces()" /></p>
            <p v-if="activeId ? pending && !recentChats.length : workspacesPending && !workspaces.length" class="text-sm text-muted" role="status">Hämtar {{ activeId ? 'chattar' : 'workspaces' }}…</p>
            <div v-else-if="activeId" class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-2.5">
              <HomeRecentCard v-for="chat in recentChats" :key="chat.id" :to="`/chat/${chat.id}`" :title="chat.title || 'Namnlös chatt'" :description="lastActive(chat.updatedAt)" icon="i-lucide-message-circle" />
              <p v-if="!recentChats.length && !threadsError" class="text-sm text-muted">Inga chattar ännu. Skriv ovan för att börja i detta workspace.</p>
            </div>
            <div v-else class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-2.5">
              <HomeRecentCard v-for="workspace in recentWorkspaces" :key="workspace.id" :to="`/?workspace=${workspace.id}`" :title="workspace.name" :description="workspace.lastActivity ? lastActive(workspace.lastActivity) : 'Öppna och börja arbeta tillsammans'" icon="i-lucide-folder" />
              <p v-if="!recentWorkspaces.length && !workspacesError" class="text-sm text-muted">Skapa ett workspace med plusknappen i sidomenyn.</p>
            </div>
          </section>

        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>

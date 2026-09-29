<script setup lang="ts">
import { startNewChat } from "~/composables/chat/navigation";
import { useThreadList } from "~/composables/chat/useThreads";

const sidebarOpen = ref(false);
provideWorkspaceAgent();
const searchOpen = ref(false);
const { container: splitContainer, width: chatWidth, dragging, start, move, finish, reset, keydown, min, max } = useWorkspaceResize();
const route = useRoute();
const hasWorkspace = computed(() => !!activeId.value && (route.path === "/" || route.path.startsWith("/chat/")));
const mobilePane = ref<"chat" | "workspace">("chat");
watch(() => route.path, () => { mobilePane.value = "chat"; });

const { threads, pending, refresh } = useThreadList();
const { activeId } = useWorkspaces();
const workspaceThreads = computed(() => threads.value.filter(t => t.workspaceId === activeId.value));
const headerTitle = computed(() => route.path === "/"
  ? "New chat"
  : threads.value.find(thread => thread.id === route.params.id)?.title ?? "Chat");

const searchGroups = computed(() => [
  {
    id: "actions",
    label: "Actions",
    items: [
      {
        label: "New chat",
        to: "/",
        icon: "i-lucide-circle-plus",
        kbds: ["meta", "o"],
        onSelect: () => startNewChat(),
      },
    ],
  },
  ...(threads.value.length
    ? [{
        id: "threads",
        label: "Recent chats",
        items: threads.value.map(thread => ({
          label: thread.title,
          to: `/chat/${thread.id}`,
          icon: "i-lucide-message-square",
        })),
      }]
    : []),
]);

defineShortcuts({
  meta_o: () => startNewChat(),
  meta_k: () => {
    searchOpen.value = true;
  },
});
</script>

<template>
  <UDashboardGroup unit="rem" class="qaa-shell">
    <UDashboardSidebar
      id="default"
      v-model:open="sidebarOpen"
      :min-size="12"
      :default-size="14.75"
      collapsible
      resizable
      :menu="{ inset: false, title: 'Navigation', description: 'Välj workspace eller chatt' }"
      class="border-r border-default"
    >
      <template #header="{ collapsed }">
        <NuxtLink
          to="/?view=workspaces"
          class="flex items-center gap-2 min-w-0"
          :class="collapsed ? 'mx-auto' : ''"
        >
          <span class="qaa-sidebar-brand"><AppLogo class="size-3.5" /></span>
          <span v-if="!collapsed" class="text-sm font-semibold">Workspace</span>
        </NuxtLink>

        <UDashboardSidebarCollapse
          v-if="!collapsed"
          class="ms-auto"
        />
      </template>

      <template #default="{ collapsed }">
        <WorkspaceSwitcher v-if="!collapsed" />
        <UNavigationMenu
          :items="[
            {
              label: 'New chat',
              icon: 'i-lucide-circle-plus',
              kbds: ['meta', 'o'],
              onSelect: () => startNewChat(),
            },
            {
              label: 'Search',
              icon: 'i-lucide-search',
              kbds: ['meta', 'k'],
              onSelect: () => {
                searchOpen = true;
              },
            },
          ]"
          :collapsed="collapsed"
          orientation="vertical"
        >
          <template #item-trailing="{ item }">
            <div
              v-if="item.kbds?.length"
              class="flex items-center gap-px opacity-0 transition-opacity group-hover:opacity-100"
            >
              <UKbd
                v-for="kbd in item.kbds"
                :key="kbd"
                :value="kbd"
                size="sm"
                variant="soft"
                class="bg-accented/50"
              />
            </div>
          </template>
        </UNavigationMenu>

        <ChatThreadList
          v-if="!collapsed"
          class="mt-3 min-h-0 flex-1 border-t border-default pt-4"
          :threads="workspaceThreads"
          :pending="pending"
          @refresh="refresh()"
        />
      </template>

      <template #footer />
    </UDashboardSidebar>

    <UDashboardSearch
      v-model:open="searchOpen"
      placeholder="Search chats and actions..."
      :groups="searchGroups"
    />

    <div class="flex min-h-0 flex-1 min-w-0 flex-col overflow-hidden">
      <AppNavbar v-if="hasWorkspace" embedded>
        <template #title>
          <div class="flex min-w-0 items-center gap-2.5">
            <UIcon name="i-lucide-panels-top-left" class="size-4 shrink-0 text-dimmed" />
            <p class="truncate text-sm font-medium text-highlighted">{{ headerTitle }}</p>
          </div>
        </template>
      </AppNavbar>
      <div v-if="hasWorkspace" class="flex shrink-0 gap-1 border-b border-default bg-default p-1.5 lg:hidden" role="group" aria-label="View">
        <UButton label="Chat" icon="i-lucide-message-square" :variant="mobilePane === 'chat' ? 'soft' : 'ghost'" :aria-pressed="mobilePane === 'chat'" color="neutral" size="sm" class="flex-1 justify-center" @click="mobilePane = 'chat'" />
        <UButton label="Workspace" icon="i-lucide-panels-top-left" :variant="mobilePane === 'workspace' ? 'soft' : 'ghost'" :aria-pressed="mobilePane === 'workspace'" color="neutral" size="sm" class="flex-1 justify-center" @click="mobilePane = 'workspace'" />
      </div>
      <div ref="splitContainer" class="flex min-h-0 min-w-0 flex-1" :class="{ 'split-dragging': dragging }" :style="{ '--chat-width': `${chatWidth}%` }">
        <section
          id="conversation-pane"
          class="relative min-h-0 min-w-0 flex-1"
          :class="[hasWorkspace ? 'lg:flex lg:w-(--chat-width) lg:flex-none' : 'flex', hasWorkspace && mobilePane === 'workspace' ? 'hidden' : 'flex']"
          aria-label="Conversation"
        >
          <slot />
        </section>
        <div
          v-if="hasWorkspace"
          role="separator"
          tabindex="0"
          aria-label="Resize chat and workspace"
          aria-orientation="vertical"
          aria-controls="conversation-pane"
          :aria-valuenow="Math.round(chatWidth)"
          :aria-valuemin="min"
          :aria-valuemax="max"
          :aria-valuetext="`Chat ${Math.round(chatWidth)}%, workspace ${100 - Math.round(chatWidth)}%`"
          title="Drag to resize · Double-click to reset"
          class="workspace-divider relative z-20 hidden w-px shrink-0 touch-none cursor-col-resize bg-default outline-none lg:block"
          :class="{ 'is-dragging': dragging }"
          @pointerdown="start"
          @pointermove="move"
          @pointerup="finish"
          @pointercancel="finish"
          @lostpointercapture="finish"
          @dblclick="reset"
          @keydown="keydown"
        >
          <span class="divider-grip absolute left-1/2 top-1/2 h-9 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accented" />
        </div>
        <WorkspacePanel
          v-if="hasWorkspace"
          class="min-w-0 flex-1 lg:flex"
          :class="mobilePane === 'workspace' ? 'flex' : 'hidden'"
        />
      </div>
    </div>
  </UDashboardGroup>
</template>

<style scoped>
.workspace-divider::before {
  content: "";
  position: absolute;
  inset: 0 -6px;
}

.workspace-divider::after {
  content: "";
  position: absolute;
  inset: 0 -1px;
  background: var(--ui-text-dimmed);
  opacity: 0;
  transition: opacity 150ms ease;
}

.workspace-divider:hover::after,
.workspace-divider:focus-visible::after,
.workspace-divider.is-dragging::after { opacity: 0.45; }

.divider-grip { transition: background-color 150ms ease, height 150ms ease; }
.workspace-divider:hover .divider-grip,
.workspace-divider:focus-visible .divider-grip,
.workspace-divider.is-dragging .divider-grip {
  height: 3rem;
  background: var(--ui-text-muted);
}

.split-dragging :deep(*) { cursor: col-resize !important; }
.split-dragging :deep(iframe) { pointer-events: none; }

@media (prefers-reduced-motion: reduce) {
  .workspace-divider::after, .divider-grip { transition: none; }
}
</style>

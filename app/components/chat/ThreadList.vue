<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type { ThreadSummary } from "#shared/types/thread";
import { deleteThread } from "~/composables/chat/navigation";
import { useThreadGroups } from "~/composables/chat/useThreadGroups";

const props = defineProps<{
  threads: ThreadSummary[];
  pending?: boolean;
}>();

const emit = defineEmits<{
  refresh: [];
}>();

const route = useRoute();
const threadsRef = toRef(props, "threads");
const { groups } = useThreadGroups(threadsRef);
const chatActivity = useState<Record<string, boolean>>('chat-activity', () => ({}));

const deletingId = ref<string | null>(null);
const confirmOpen = ref(false);
const targetThread = ref<ThreadSummary | null>(null);

function isActive(id: string) {
  return route.params.id === id;
}

function contextItems(thread: ThreadSummary): DropdownMenuItem[][] {
  return [[
    {
      label: "Delete",
      icon: "i-lucide-trash-2",
      color: "error",
      onSelect: () => openDelete(thread),
    },
  ]];
}

function openDelete(thread: ThreadSummary) {
  targetThread.value = thread;
  confirmOpen.value = true;
}

async function confirmDelete() {
  if (!targetThread.value) return;

  deletingId.value = targetThread.value.id;
  try {
    await deleteThread(targetThread.value.id);
    emit("refresh");
  }
  finally {
    deletingId.value = null;
    confirmOpen.value = false;
    targetThread.value = null;
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div
      v-if="pending && !threads.length"
      class="px-3 py-1 text-sm text-muted"
    >
      Hämtar chattar…
    </div>

    <p
      v-else-if="!threads.length"
      class="px-3 py-1 text-sm text-muted"
    >
      Inga chattar här ännu.
    </p>

    <UScrollArea
      v-else
      class="min-h-0 flex-1"
    >
      <nav class="flex flex-col gap-px p-1.5">
        <template
          v-for="(group, groupIndex) in groups"
          :key="group.id"
        >
          <p
            class="px-2.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted"
            :class="groupIndex > 0 && 'mt-2 border-t border-default pt-3'"
          >
            {{ group.label }}
          </p>

          <UContextMenu
            v-for="thread in group.items"
            :key="thread.id"
            :items="contextItems(thread)"
            size="sm"
          >
            <NuxtLink
              :to="`/chat/${thread.id}`"
              class="qaa-chat-link flex items-center gap-2 overflow-hidden rounded-lg px-3 py-2 text-sm transition-colors"
              :aria-current="isActive(thread.id) ? 'page' : undefined"
              :class="isActive(thread.id)
                ? 'bg-elevated text-highlighted font-medium'
                : 'text-muted hover:bg-elevated hover:text-highlighted'"
            >
              <UIcon name="i-lucide-message-square" class="size-3.5 shrink-0" />
              <span class="truncate">{{ thread.title }}</span>
              <span v-if="chatActivity[thread.id]" class="ml-auto flex shrink-0 items-center" role="status">
                <UIcon name="i-lucide-loader-circle" class="size-3.5 text-primary motion-safe:animate-spin" aria-hidden="true" />
                <span class="sr-only">Agenten arbetar</span>
              </span>
            </NuxtLink>
          </UContextMenu>
        </template>
      </nav>
    </UScrollArea>

    <UModal
      v-model:open="confirmOpen"
      title="Delete chat?"
      :description="`“${targetThread?.title}” will be removed from your history. This cannot be undone.`"
    >
      <template #footer>
        <UButton
          color="neutral"
          variant="outline"
          label="Cancel"
          @click="() => { confirmOpen = false }"
        />
        <UButton
          color="error"
          label="Delete"
          :loading="!!deletingId"
          @click="confirmDelete"
        />
      </template>
    </UModal>
  </div>
</template>

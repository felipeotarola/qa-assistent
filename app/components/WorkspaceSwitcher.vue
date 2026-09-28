<script setup lang="ts">
import { startNewChat } from "~/composables/chat/navigation";
const { workspaces, activeId, selected, refresh } = useWorkspaces();
const creating = ref(false);
const name = ref("");
const busy = ref(false);
const error = ref("");
async function select(id: string) {
  await startNewChat();
  selected.value = id;
}
async function create() {
  if (!name.value.trim()) return;
  busy.value = true;
  try {
    const { workspace } = await $fetch<{ workspace: { id: string } }>("/api/workspaces", { method: "POST", body: { name: name.value } });
    await refresh();
    await select(workspace.id);
    creating.value = false; name.value = ""; error.value = "";
  }
  catch { error.value = "Kunde inte skapa workspace."; }
  finally { busy.value = false; }
}
</script>
<template>
  <div class="space-y-2 px-2 py-3">
    <div class="flex items-center gap-1">
      <USelect :model-value="activeId || undefined" :items="workspaces.map(w => ({ label: w.name, value: w.id }))" aria-label="Välj workspace" class="min-w-0 flex-1" @update:model-value="select($event as string)" />
      <UButton icon="i-lucide-plus" aria-label="Skapa workspace" variant="ghost" color="neutral" @click="creating = !creating" />
    </div>
    <form v-if="creating" class="flex gap-1" @submit.prevent="create">
      <UInput v-model="name" placeholder="Namn på workspace" aria-label="Namn på workspace" class="min-w-0 flex-1" autofocus />
      <UButton type="submit" icon="i-lucide-check" aria-label="Skapa" :loading="busy" />
    </form>
    <p v-if="error" class="text-xs text-error" role="alert">{{ error }}</p>
  </div>
</template>

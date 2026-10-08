<script setup lang="ts">
import type { Workspace } from '#shared/workspace';
const props = defineProps<{ workspace: Workspace }>();
const { refresh, selected, bindings } = useWorkspaces();
const open = ref(false);
const busy = ref(false);
const error = ref('');
async function save() {
  const id = props.workspace.id;
  const archived = !props.workspace.archivedAt;
  busy.value = true; error.value = '';
  try {
    await $fetch(`/api/workspaces/${id}/archive`, { method: 'PUT', body: { archived } });
    if (archived) {
      if (selected.value === id) selected.value = null;
      bindings.value = Object.fromEntries(Object.entries(bindings.value).filter(([, value]) => value !== id));
    }
    await refresh();
    open.value = false;
    await navigateTo('/?view=workspaces');
  } catch (err) {
    error.value = (err as { data?: { statusMessage?: string } }).data?.statusMessage || 'Kunde inte uppdatera workspacet. Försök igen.';
  } finally { busy.value = false; }
}
</script>

<template>
  <UButton :icon="workspace.archivedAt ? 'i-lucide-archive-restore' : 'i-lucide-archive'" :label="workspace.archivedAt ? 'Återställ' : undefined" :aria-label="`${workspace.archivedAt ? 'Återställ' : 'Arkivera'} ${workspace.name}`" :title="workspace.archivedAt ? 'Återställ workspace' : 'Arkivera workspace'" color="neutral" variant="ghost" @click="error = ''; open = true" />
  <UModal v-model:open="open" :title="workspace.archivedAt ? 'Återställ workspace' : 'Arkivera workspace'" :description="workspace.name" :ui="{ content: 'qaa-modal-confirmation' }" :dismissible="!busy" :close="{ disabled: busy }">
    <template #body>
      <div class="space-y-4">
        <div class="flex items-start gap-3 rounded-xl bg-muted/50 p-4">
          <UIcon :name="workspace.archivedAt ? 'i-lucide-archive-restore' : 'i-lucide-archive'" class="mt-0.5 size-5 shrink-0 text-muted" />
          <div class="min-w-0 space-y-1">
            <p class="text-sm font-medium text-highlighted">{{ workspace.archivedAt ? 'Tillbaka i din arbetsyta' : 'Spara undan, behåll innehållet' }}</p>
            <p class="text-sm leading-relaxed text-muted">{{ workspace.archivedAt ? 'Workspacet visas igen i listan och väljaren, med allt innehåll kvar.' : 'Chattar, testresultat, material och nycklar finns kvar. Workspacet döljs bara från din vanliga lista.' }}</p>
          </div>
        </div>
        <p v-if="!workspace.archivedAt" class="text-sm leading-relaxed text-muted">Du hittar det under <span class="font-medium text-default">Alla workspaces → Arkiverade</span> och kan återställa det när du vill.</p>
        <p v-if="!workspace.archivedAt" class="text-xs leading-relaxed text-muted">Jobb och delningslänkar påverkas inte. Projekt i GitHub och Linear lämnas kvar.</p>
        <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton label="Avbryt" color="neutral" variant="outline" :disabled="busy" @click="open = false" />
        <UButton :label="workspace.archivedAt ? 'Återställ workspace' : 'Arkivera workspace'" :loading="busy" @click="save" />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import type { SandboxState } from '#shared/sandbox';
const sessions = useState<SandboxState[]>('execution-sandboxes', () => []);
const { activeId } = useWorkspaces();
const minimized = ref(false), busy = ref(false), error = ref('');
const latest = computed(() => sessions.value.at(-1));
watch(() => latest.value?.id, () => { minimized.value = false; });
async function stop(id: string) {
  busy.value = true; error.value = '';
  try { await $fetch(`/api/workspaces/${activeId.value}/sandboxes`, { method: 'POST', body: { id, action: 'stop' } }); }
  catch { error.value = 'Kunde inte bekräfta stopp. Senast kända status visas.'; }
  finally { busy.value = false; }
}
</script>
<template>
  <ClientOnly><Teleport defer to="#floating-work-panels">
    <section v-if="sessions.length" aria-label="Arbetsmiljöer på VPS" class="pointer-events-auto w-[28rem] max-w-full shrink-0 overflow-hidden rounded-xl border border-default bg-default shadow-xl">
      <header class="flex items-center gap-2 p-3"><UIcon name="i-lucide-container" class="size-4" /><h2 class="flex-1 text-sm font-semibold">Arbetsmiljö på VPS</h2><UButton :icon="minimized ? 'i-lucide-chevron-up' : 'i-lucide-minus'" :aria-label="minimized ? 'Visa arbetsmiljö' : 'Minimera arbetsmiljö'" :aria-expanded="!minimized" variant="ghost" size="xs" @click="minimized = !minimized" /></header>
      <div v-show="!minimized" class="max-h-[55dvh] space-y-4 overflow-auto border-t border-default p-4">
        <article v-for="session in sessions" :key="session.id" class="space-y-3">
          <p class="text-sm" role="status">{{ session.message }}</p><p class="text-xs text-muted">{{ session.id.slice(0, 8) }} · {{ session.status }} · {{ session.processes.length }} processer</p>
          <details v-for="process in session.processes" :key="process.id" :open="process.status === 'running'"><summary class="cursor-pointer text-xs">Process {{ process.id.slice(0, 8) }} · {{ process.status }}<span v-if="process.exitCode !== null"> · exit {{ process.exitCode }}</span></summary><pre class="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{{ process.stdout }}{{ process.stderr }}</pre></details>
          <UButton v-if="session.status === 'ready'" label="Stoppa miljön" icon="i-lucide-square" size="sm" variant="outline" :loading="busy" @click="stop(session.id)" />
        </article>
        <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
      </div>
    </section>
  </Teleport></ClientOnly>
</template>

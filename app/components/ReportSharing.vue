<script setup lang="ts">
import type { ReportDocument } from '#shared/mission-report';
import { sharedReportDocument } from '#shared/report-sharing';
const props = defineProps<{ workspaceId: string; reportId: string; document: ReportDocument }>();
const open = ref(false), mode = ref<'pin' | 'public'>('pin'), pin = ref(''), expires = ref(''), included = ref<string[]>([]), busy = ref(false), error = ref(''), newPin = ref('');
const endpoint = computed(() => `/api/workspaces/${props.workspaceId}/reports/${props.reportId}/share`);
const { data, refresh } = useAsyncData(() => `report-share-${props.reportId}`, () => useRequestFetch()<{ share: { mode: string; path: string; expiresAt: string | null } | null }>(endpoint.value));
const origin = useRequestURL().origin;
const preview = computed(() => sharedReportDocument(props.document, included.value));
const previewAssets = computed(() => props.document.evidence.filter(e => included.value.includes(e.id)).map(e => ({ id: e.id, url: `/api/workspaces/${props.workspaceId}/reports/${props.reportId}/asset?evidenceId=${encodeURIComponent(e.id)}` })));
async function submit(action: 'create' | 'revoke' | 'change_pin') {
  busy.value = true; error.value = ''; newPin.value = '';
  try {
    const response = await $fetch<{ pin?: string }>(endpoint.value, { method: 'POST', body: action === 'create' ? { action, mode: mode.value, ...(mode.value === 'pin' && pin.value ? { pin: pin.value } : {}), expiresAt: expires.value ? new Date(expires.value).toISOString() : null, evidenceIds: included.value } : { action, ...(action === 'change_pin' ? { pin: pin.value } : {}) } });
    newPin.value = response.pin ?? ''; pin.value = ''; await refresh();
  } catch { error.value = 'Delningen kunde inte ändras. Kontrollera status och försök igen.'; } finally { busy.value = false; }
}
async function copy() { if (data.value?.share) await navigator.clipboard.writeText(origin + data.value.share.path); }
watch(open, value => { if (!value) { pin.value = ''; newPin.value = ''; } });
</script>
<template>
  <UModal v-model:open="open" title="Dela rapport" description="Dela den här rapportversionen. Nya resultat publiceras inte automatiskt.">
    <UButton label="Dela rapport" icon="i-lucide-share-2" color="neutral" variant="outline" />
    <template #body><div class="space-y-5">
      <p class="text-sm font-medium">{{ document.title }} · revision {{ document.revision }}</p>
      <div v-if="data?.share" class="space-y-3 rounded-lg border border-default p-3"><p>{{ data.share.mode === 'pin' ? 'Privat med pinkod' : 'Publik' }}</p><UInput :model-value="origin + data.share.path" readonly aria-label="Delningslänk" class="w-full" /><div class="flex flex-wrap gap-2"><UButton label="Kopiera länk" icon="i-lucide-copy" @click="copy" /><UButton label="Öppna mottagarens sida" :to="data.share.path" target="_blank" variant="outline" color="neutral" /><UButton label="Stäng delning" color="error" variant="soft" :loading="busy" @click="submit('revoke')" /></div></div>
      <p v-if="newPin" class="rounded-lg border border-default p-3">Pinkod: <strong class="font-mono tracking-widest">{{ newPin }}</strong><br><span class="text-xs text-muted">Spara koden nu. Den kan bytas men inte hämtas igen.</span></p>
      <UFormField label="Åtkomst"><USelect v-model="mode" :items="[{ label: 'Privat med pinkod', value: 'pin' }, { label: 'Publik utan pinkod', value: 'public' }]" class="w-full" /></UFormField>
      <p class="text-sm text-muted">{{ mode === 'pin' ? 'Alla med länken och koden kan läsa rapporten utan konto.' : 'Alla med länken kan läsa rapporten utan konto eller pinkod.' }}</p>
      <UFormField v-if="mode === 'pin'" label="Sexsiffrig pinkod" description="Lämna tomt för att generera en kod vid aktivering."><UInput v-model="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off" class="w-full" /></UFormField>
      <UFormField label="Giltig till" description="Valfritt"><UInput v-model="expires" type="datetime-local" class="w-full" /></UFormField>
      <fieldset v-if="document.evidence.some(e => e.itemId && e.kind === 'image')" class="space-y-2"><legend class="mb-2 font-medium">Bilder som ska ingå</legend><UCheckbox v-for="ref in document.evidence.filter(e => e.itemId && e.kind === 'image')" :key="ref.id" :model-value="included.includes(ref.id)" :label="ref.title" @update:model-value="value => included = value ? [...included, ref.id] : included.filter(id => id !== ref.id)" /></fieldset>
      <UCollapsible><UButton label="Förhandsvisa mottagarens innehåll" color="neutral" variant="link" /><template #content><MissionReportDocument :document="preview" :assets="previewAssets" /></template></UCollapsible>
      <p v-if="error" role="alert" class="text-error">{{ error }}</p>
    </div></template>
    <template #footer><div class="flex flex-wrap gap-2"><UButton :label="data?.share ? 'Skapa ny delningslänk' : 'Aktivera delning'" :loading="busy" :disabled="mode === 'pin' && !!pin && !/^\d{6}$/.test(pin)" @click="submit('create')" /><UButton v-if="data?.share?.mode === 'pin'" label="Byt pinkod" variant="outline" color="neutral" :disabled="!/^\d{6}$/.test(pin)" :loading="busy" @click="submit('change_pin')" /><UButton label="Stäng" variant="ghost" color="neutral" @click="open = false" /></div></template>
  </UModal>
</template>

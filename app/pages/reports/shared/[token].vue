<script setup lang="ts">
import type { ReportDocument } from '#shared/mission-report';
definePageMeta({ layout: false });
useHead({ title: 'Delad rapport', meta: [{ name: 'robots', content: 'noindex,nofollow,noarchive' }, { name: 'referrer', content: 'no-referrer' }] });
const route = useRoute(), pin = ref(''), busy = ref(false), message = ref('');
const endpoint = computed(() => `/api/report-shares/${route.params.token}`);
const { data, error, refresh } = await useAsyncData(() => `share-${route.params.token}`, () => useRequestFetch()<{ locked: boolean; document?: ReportDocument; assets?: { id: string; url: string }[] }>(endpoint.value));
// The PIN cookie is scoped to the API, never to the application or SSR page.
onMounted(() => { if (data.value?.locked) void refresh({ cachedData: undefined }); });
async function unlock() { busy.value = true; message.value = ''; try { await $fetch(`${endpoint.value}/unlock`, { method: 'POST', body: { pin: pin.value } }); pin.value = ''; await refresh(); } catch (e) { message.value = (e as { statusCode?: number }).statusCode === 429 ? 'För många försök. Försök igen om 15 minuter.' : 'Koden stämmer inte eller länken har slutat gälla.'; } finally { busy.value = false; } }
function print() { window.print(); }
</script>
<template>
  <main class="min-h-screen bg-default text-default px-4 py-8 sm:px-8">
    <div v-if="error" class="mx-auto max-w-lg rounded-xl border border-default p-6"><h1 class="text-xl font-semibold">Länken är inte tillgänglig</h1><p class="mt-2 text-muted">Den kan ha gått ut eller stängts av av rapportägaren.</p></div>
    <form v-else-if="data?.locked" class="mx-auto max-w-sm space-y-4 rounded-xl border border-default p-6" @submit.prevent="unlock"><h1 class="text-xl font-semibold">Privat rapport</h1><p class="text-muted">Ange den sexsiffriga pinkoden från rapportägaren. Du behöver inget konto.</p><UFormField label="Pinkod"><UInput v-model="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off" class="w-full" /></UFormField><p v-if="message" role="alert" class="text-sm text-error">{{ message }}</p><UButton type="submit" :loading="busy" :disabled="!/^\d{6}$/.test(pin)" label="Öppna rapport" /></form>
    <div v-else-if="data?.document" class="mx-auto max-w-5xl"><div class="mb-4 flex justify-end print:hidden"><UButton label="Skriv ut eller spara PDF" icon="i-lucide-printer" variant="outline" color="neutral" @click="print" /></div><MissionReportDocument :document="data.document" :assets="data.assets" /></div>
  </main>
</template>

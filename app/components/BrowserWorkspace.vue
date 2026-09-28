<script setup lang="ts">
import type { BrowserView } from "#shared/browser";

const props = defineProps<{ threadId: string }>();
const browser = shallowRef<BrowserView | null>(null);
const error = ref("");
const busy = ref(false);
const loaded = ref(false);
const disconnected = ref(false);
const expanded = ref(false);
const preview = useTemplateRef("preview");
const previewWidth = ref(320);
let previewObserver: ResizeObserver | undefined;
watch(preview, (element) => {
  previewObserver?.disconnect();
  if (!element) return;
  previewObserver = new ResizeObserver(([entry]) => {
    if (entry) previewWidth.value = entry.contentRect.width;
  });
  previewObserver.observe(element);
});
const browserResume = useState<string | null>("browser-resume", () => null);
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let polling = false;
let revision = 0;

async function refresh() {
  if (polling || busy.value || disposed) return;
  polling = true;
  const currentRevision = revision;
  try {
    const result = await $fetch<{ browser: BrowserView | null }>(`/api/threads/${props.threadId}/browser`);
    if (!disposed && currentRevision === revision) { browser.value = result.browser; error.value = ""; }
  }
  catch { if (!disposed) error.value = "Kunde inte ansluta till webbläsaren. Försöker igen…"; }
  finally { polling = false; }
}

async function poll() {
  await refresh();
  if (!disposed) timer = setTimeout(poll, 2500);
}

async function control(value: "human" | "agent" | "close") {
  if (busy.value) return;
  busy.value = true;
  revision++;
  error.value = "";
  try {
    const result = await $fetch<{ browser: BrowserView | null }>(`/api/threads/${props.threadId}/browser`, { method: "POST", body: { control: value } });
    if (disposed) return;
    browser.value = result.browser;
    if (value === "agent" && result.browser) browserResume.value = props.threadId;
  }
  catch { error.value = "Det gick inte att ändra kontrollen. Försök igen."; }
  finally { busy.value = false; }
}

// Cross-origin iframe activity cannot be read. While the user has focused the
// live browser, explicitly renew its idle lease; the provider's hard cap remains.
let heartbeat: ReturnType<typeof setInterval> | undefined;
function onMessage(event: MessageEvent) {
  if (!browser.value || event.origin !== new URL(browser.value.liveUrl).origin) return;
  if (event.data === "browserbase-disconnected") disconnected.value = true;
}
watch(() => browser.value?.sessionId, () => { loaded.value = false; disconnected.value = false; expanded.value = false; });
onMounted(() => {
  void poll();
  window.addEventListener("message", onMessage);
  heartbeat = setInterval(() => {
    if (expanded.value && browser.value?.control === "human" && document.visibilityState === "visible" && document.activeElement?.tagName === "IFRAME") {
      void $fetch(`/api/threads/${props.threadId}/browser`, { method: "POST", body: { control: "heartbeat" } }).catch(() => {});
    }
  }, 30000);
});
onBeforeUnmount(() => {
  disposed = true;
  previewObserver?.disconnect();
  clearTimeout(timer);
  clearInterval(heartbeat);
  window.removeEventListener("message", onMessage);
});

const displayUrl = computed(() => {
  try { const url = new URL(browser.value?.url ?? ""); return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`; }
  catch { return "Startar Chromium…"; }
});
</script>

<template>
  <div class="workspace-surface relative flex h-full min-h-0 flex-col overflow-hidden">
    <div class="flex h-12 shrink-0 items-center gap-2 px-5 text-xs text-muted">
      <UIcon name="i-lucide-layout-grid" class="size-3.5" /> Workspace
      <span v-if="browser" class="ml-auto text-[10px] text-dimmed">1 objekt</span>
    </div>
    <div v-if="browser" class="min-h-0 flex-1 overflow-auto px-5 pb-5">
    <WorkspaceCard v-model:expanded="expanded" :title="browser.title || 'Webbläsare'" :subtitle="displayUrl" icon="i-lucide-globe-2">
      <template #toolbar>
      <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-default p-3">
        <div class="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-default bg-muted px-3 py-2">
          <UIcon name="i-lucide-globe-2" class="size-4 shrink-0 text-muted" />
          <span class="truncate text-xs text-muted" :title="browser.url">{{ displayUrl }}</span>
        </div>
        <UButton
          :icon="browser.control === 'human' ? 'i-lucide-bot' : 'i-lucide-mouse-pointer-2'"
          :label="browser.control === 'human' ? 'Lämna tillbaka' : 'Ta över'"
          size="sm" color="neutral" :variant="browser.control === 'human' ? 'solid' : 'soft'"
          :loading="busy" :disabled="disconnected"
          @click="control(browser.control === 'human' ? 'agent' : 'human')"
        />
        <UButton icon="i-lucide-x" aria-label="Stäng webbläsaren" title="Stäng webbläsaren" color="neutral" variant="ghost" size="sm" :disabled="busy" @click="control('close')" />
      </div>
      <div class="flex shrink-0 items-center gap-2 border-b border-default/60 px-4 py-2 text-xs text-muted" role="status">
        <span class="size-1.5 rounded-full" :class="browser.control === 'human' ? 'bg-amber-400' : 'bg-emerald-400'" />
        {{ busy ? 'Byter kontroll — väntar på pågående åtgärd…' : browser.control === 'human' ? 'Du styr. Logga in eller navigera, och lämna sedan tillbaka.' : 'Agenten styr · Du kan ta över när du vill' }}
      </div>
      </template>
      <template #default>
      <div ref="preview" class="relative h-full min-h-0 overflow-hidden bg-white">
        <iframe
          :key="browser.sessionId" :src="browser.liveUrl" title="Live Chromium"
          class="origin-top-left border-0" :class="{ 'pointer-events-none': !expanded || browser.control !== 'human' || busy }"
          :style="expanded ? { width: '100%', height: '100%' } : { width: '1280px', height: '900px', transform: `scale(${previewWidth / 1280})` }"
          :tabindex="expanded && browser.control === 'human' && !busy ? 0 : -1"
          :inert="!expanded || browser.control !== 'human' || busy"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
          allow="clipboard-read; clipboard-write" referrerpolicy="no-referrer"
          @load="loaded = true"
        />
        <div v-if="!loaded || disconnected" class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-default text-sm text-muted">
          <UIcon :name="disconnected ? 'i-lucide-unplug' : 'i-lucide-loader-circle'" class="size-6" :class="{ 'animate-spin': !disconnected }" />
          <span>{{ disconnected ? 'Sessionen har avslutats.' : 'Ansluter till livewebbläsaren…' }}</span>
          <UButton v-if="disconnected" label="Stäng" variant="soft" color="neutral" @click="control('close')" />
        </div>
      </div>
      </template>
      <template #footer>
      <div class="flex h-9 shrink-0 items-center justify-between gap-2 px-4 text-[10px] text-dimmed">
        <span class="flex items-center gap-1.5"><span class="size-1.5 rounded-full" :class="disconnected ? 'bg-accented' : browser.control === 'human' ? 'bg-amber-400' : 'bg-emerald-400'" />{{ disconnected ? 'Frånkopplad' : browser.control === 'human' ? 'Du har kontrollen' : 'Live · Webbläsare' }}</span>
        <span>{{ expanded ? 'Stängs efter inaktivitet · max 30 min' : 'Klicka för att öppna' }}</span>
      </div>
      <p v-if="error" role="alert" class="border-t border-default px-4 py-3 text-xs text-error">{{ error }}</p>
      </template>
    </WorkspaceCard>
    </div>
    <div v-else class="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <div class="flex size-16 items-center justify-center rounded-2xl border border-default bg-muted shadow-sm">
        <UIcon name="i-lucide-panels-top-left" class="size-7 text-muted" />
      </div>
      <div>
        <h3 class="text-lg font-medium text-highlighted">Här tar arbetet form.</h3>
        <p class="mt-2 max-w-64 text-sm leading-relaxed text-muted">En gemensam yta för verktyg och resultat.<br>Börja med att be agenten öppna en hemsida.</p>
      </div>
      <span class="rounded-full border border-default px-3 py-1.5 text-xs text-dimmed">Prova ”Gå till Wikipedia”</span>
    </div>
    <p v-if="error && !browser" role="alert" class="shrink-0 border-t border-default px-4 py-3 text-xs text-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.workspace-surface {
  background-color: var(--ui-bg);
  background-image: radial-gradient(color-mix(in oklab, var(--ui-text-dimmed) 16%, transparent) 0.7px, transparent 0.7px);
  background-size: 20px 20px;
}
</style>

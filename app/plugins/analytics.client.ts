import { injectAnalytics } from '@vercel/analytics/nuxt/runtime';
export default defineNuxtPlugin(() => {
  const route = useRoute(); let injected = false;
  watch(() => route.path, path => {
    if (injected || path.startsWith('/reports/')) return;
    injected = true;
    injectAnalytics({ beforeSend: event => new URL(event.url).pathname.startsWith('/reports/') ? null : event });
  }, { immediate: true });
});

<script setup lang="ts">
const colorMode = useColorMode();
const chatSessionRevisions = useState<Record<string, number>>('chat-session-revisions', () => ({}));

const themeColor = computed(() => (colorMode.value === "dark" ? "#1b1718" : "#ffffff"));

useHead({
  meta: [
    { key: "theme-color", name: "theme-color", content: themeColor },
  ],
});

useSiteSeo();
</script>

<template>
  <UApp :toaster="{ position: 'top-right' }" :tooltip="{ delayDuration: 200 }">
    <NuxtLoadingIndicator color="var(--ui-text-highlighted)" />

    <NuxtLayout>
      <NuxtPage :page-key="route => `${route.path}:${chatSessionRevisions[String(route.params.id)] ?? 0}`" />
    </NuxtLayout>
  </UApp>
</template>

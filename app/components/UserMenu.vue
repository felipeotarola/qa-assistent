<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import { authClient } from "~/lib/auth-client";

defineProps<{ collapsed?: boolean }>();

const session = authClient.useSession();
const colorMode = useColorMode();

const user = computed(() => session.value?.data?.user);

const displayName = computed(
  () => user.value?.name?.trim() || user.value?.email?.split("@")[0] || "Account",
);

const items = computed<DropdownMenuItem[][]>(() => [
  [
    {
      label: "Profil och inställningar",
      icon: "i-lucide-settings",
      to: "/settings/profile",
    },
    {
      label: "Integrationer",
      icon: "i-lucide-plug",
      to: "/settings/integrations",
    },
  ],
  [
    {
      label: "Tema",
      icon: "i-lucide-palette",
      children: [
        { label: "Ljust", icon: "i-lucide-sun", type: "checkbox", checked: colorMode.preference === "light", onSelect: () => { colorMode.preference = "light"; } },
        { label: "Mörkt", icon: "i-lucide-moon", type: "checkbox", checked: colorMode.preference === "dark", onSelect: () => { colorMode.preference = "dark"; } },
        { label: "System", icon: "i-lucide-monitor", type: "checkbox", checked: colorMode.preference === "system", onSelect: () => { colorMode.preference = "system"; } },
      ],
    },
  ],
  [
    {
      label: "Logga ut",
      icon: "i-lucide-log-out",
      onSelect: signOut,
    },
  ],
]);

async function signOut() {
  await authClient.signOut();
  await navigateTo("/login");
}
</script>

<template>
  <UDropdownMenu
    v-if="user"
    :items
    :content="{ side: collapsed ? 'right' : 'top', align: 'start', collisionPadding: 12 }"
    :ui="{ content: 'min-w-56 p-1' }"
  >
    <UButton
      color="neutral"
      variant="ghost"
      :square="collapsed"
      class="w-full min-w-0 data-[state=open]:bg-elevated"
      :class="collapsed ? 'justify-center' : 'justify-start'"
      :label="collapsed ? undefined : displayName"
      :trailing-icon="collapsed ? undefined : 'i-lucide-chevrons-up-down'"
      :ui="{ label: 'truncate flex-1 text-left', trailingIcon: 'shrink-0 text-dimmed' }"
      :avatar="{
        alt: displayName,
        size: 'sm',
      }"
      :aria-label="`Kontomeny för ${displayName}`"
    />

    <template #content-top="{ sub }">
      <div
        v-if="!sub"
        class="px-2 pb-1 pt-1.5"
      >
        <div class="flex items-center gap-2.5 px-1 py-1">
          <UAvatar
            :alt="displayName"
            size="sm"
          />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-highlighted">
              {{ displayName }}
            </p>
            <p
              v-if="user?.email"
              class="truncate text-xs text-muted"
            >
              {{ user.email }}
            </p>
          </div>
        </div>
        <USeparator class="mt-2" />
      </div>
    </template>
  </UDropdownMenu>
</template>

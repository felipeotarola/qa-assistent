<script setup lang="ts">
import { authClient } from "~/lib/auth-client";

definePageMeta({
  layout: false,
});

const route = useRoute();
const mode = ref<"sign-in" | "sign-up">("sign-in");
const email = ref("");
const password = ref("");
const name = ref("");
const error = ref(route.query.confirmation === "failed" ? "Confirmation link expired or invalid. Please sign in or request a new link." : "");
const notice = ref("");
const loading = ref(false);

const redirectTo = computed(() => {
  const value = route.query.redirect;
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "/";
});

async function handleSubmit() {
  error.value = "";
  notice.value = "";
  loading.value = true;

  try {
    if (mode.value === "sign-up") {
      const result = await authClient.signUp.email({
        email: email.value,
        password: password.value,
        name: name.value || email.value.split("@")[0] || "User",
      });

      if (result.error) {
        error.value = result.error.message ?? "Sign up failed.";
        return;
      }
      if (!result.data.session) {
        notice.value = "Check your email to confirm your account, then sign in.";
        return;
      }
    }
    else {
      const result = await authClient.signIn.email({
        email: email.value,
        password: password.value,
      });

      if (result.error) {
        error.value = result.error.message ?? "Sign in failed.";
        return;
      }
    }

    await authClient.getSession();
    await navigateTo(redirectTo.value);
  }
  catch {
    error.value = "Could not sign in. Please try again.";
  }
  finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-svh bg-default text-default">
    <section class="flex flex-1 items-center justify-center px-6 py-10">
      <div class="w-full max-w-sm">
        <UCard class="w-full">
          <template #header>
            <h2 class="text-lg font-semibold text-highlighted">
              {{ mode === "sign-in" ? "Sign in" : "Create account" }}
            </h2>
          </template>

          <form
            class="space-y-4"
            @submit.prevent="handleSubmit"
          >
            <UFormField
              v-if="mode === 'sign-up'"
              label="Name"
            >
              <UInput
                v-model="name"
                class="w-full"
                autocomplete="name"
                placeholder="Your name"
              />
            </UFormField>

            <UFormField label="Email">
              <UInput
                v-model="email"
                class="w-full"
                type="email"
                autocomplete="email"
                required
                placeholder="you@example.com"
              />
            </UFormField>

            <UFormField label="Password">
              <UInput
                v-model="password"
                class="w-full"
                type="password"
                autocomplete="current-password"
                required
                minlength="6"
                placeholder="••••••••"
              />
            </UFormField>

            <p
              v-if="error"
              class="text-sm text-error"
            >
              {{ error }}
            </p>

            <p v-if="notice" class="text-sm text-muted" role="status">
              {{ notice }}
            </p>

            <UButton
              type="submit"
              block
              color="neutral"
              :loading="loading"
            >
              {{ mode === "sign-in" ? "Sign in" : "Create account" }}
            </UButton>
          </form>

          <template #footer>
            <p class="text-center text-sm text-muted">
              <button
                type="button"
                class="text-highlighted hover:underline"
                @click="mode = mode === 'sign-in' ? 'sign-up' : 'sign-in'"
              >
                {{
                  mode === "sign-in"
                    ? "Need an account? Sign up"
                    : "Already have an account? Sign in"
                }}
              </button>
            </p>
          </template>
        </UCard>
      </div>
    </section>
  </div>
</template>

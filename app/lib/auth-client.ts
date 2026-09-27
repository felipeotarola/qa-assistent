import { createBrowserClient } from "@supabase/ssr";

type AppSession = { user: { id: string; email: string; name: string } } | null;

function client() {
  const config = useRuntimeConfig().public;
  return createBrowserClient(config.supabaseUrl, config.supabasePublishableKey, {
    cookieOptions: { name: "pat_supabase_auth", sameSite: "lax", path: "/" },
  });
}

async function getSession() {
  const state = useState<{ data: AppSession }>("app-session", () => ({ data: null }));
  const data = await useRequestFetch()<AppSession>("/api/auth/get-session");
  state.value = { data };
  return { data };
}

export const authClient = {
  signIn: {
    email: (credentials: { email: string; password: string }) => client().auth.signInWithPassword(credentials),
  },
  signUp: {
    email: ({ name, ...credentials }: { email: string; password: string; name: string }) =>
      client().auth.signUp({ ...credentials, options: {
        data: { name },
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      } }),
  },
  async signOut() {
    const state = useState<{ data: AppSession }>("app-session");
    const { error } = await client().auth.signOut({ scope: "local" });
    if (error) throw error;
    state.value = { data: null };
  },
  getSession,
  useSession() {
    const state = useState<{ data: AppSession }>("app-session", () => ({ data: null }));
    if (import.meta.client) {
      // Starts the browser refresh loop for existing sessions as well.
      client();
      void getSession().catch(() => { state.value = { data: null }; });
    }
    return state;
  },
};

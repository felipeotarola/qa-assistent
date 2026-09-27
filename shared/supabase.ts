import { createServerClient, parseCookieHeader, type CookieOptions } from "@supabase/ssr";

export function supabaseConfig() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase URL and publishable key are required.");
  return { url, key };
}

// Shared by Nitro and Eve. Always validate identity with auth.getUser().
export function createRequestSupabase(
  cookie: string,
  setAll: (cookies: { name: string; value: string; options: CookieOptions }[]) => void = () => {},
) {
  const { url, key } = supabaseConfig();
  return createServerClient(url, key, {
    cookieOptions: { name: "pat_supabase_auth", sameSite: "lax", path: "/" },
    cookies: {
      getAll: () => parseCookieHeader(cookie).map(({ name, value }) => ({ name, value: value ?? "" })),
      setAll,
    },
  });
}

import type { H3Event } from "h3";
import { db, schema } from "@nuxthub/db";
import { createRequestSupabase } from "#shared/supabase";
import { getNodeRequest } from "./h3-node";

export function getAppSession(event: H3Event) {
  return event.context.appSession ??= resolveAppSession(event);
}

export function getSupabaseForEvent(event: H3Event) {
  return createRequestSupabase(getRequestHeader(event, "cookie") || "", (cookies) => {
    const merged = parseCookies(event);
    for (const { name, value, options } of cookies) {
      setCookie(event, name, value, options);
      merged[name] = value;
    }
    // SSR subrequests and the Eve proxy must see the refreshed cookie too.
    getNodeRequest(event).headers.cookie = Object.entries(merged)
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
  });
}

async function resolveAppSession(event: H3Event) {
  const client = getSupabaseForEvent(event);
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  const user = data.user;
  if (!user.email) return null;
  const metadataName = user.user_metadata?.name ?? user.user_metadata?.full_name;
  const [local] = await db.insert(schema.user).values({
    id: user.id,
    email: user.email,
    name: typeof metadataName === "string" ? metadataName : user.email.split("@")[0]!,
    emailVerified: !!user.email_confirmed_at,
  }).onConflictDoUpdate({
    target: schema.user.id,
    // The Profile page owns the local display name after first sign-in.
    set: { email: user.email, emailVerified: !!user.email_confirmed_at },
  }).returning();
  return { user: { id: local!.id, email: local!.email, name: local!.name } };
}

declare module "h3" {
  interface H3EventContext {
    appSession?: ReturnType<typeof resolveAppSession>;
  }
}

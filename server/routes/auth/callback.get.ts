import { getSupabaseForEvent } from "~~/server/utils/supabase";

export default defineEventHandler(async (event) => {
  const code = getQuery(event).code;
  if (typeof code === "string") {
    const { error } = await getSupabaseForEvent(event).auth.exchangeCodeForSession(code);
    if (!error) return sendRedirect(event, "/");
  }
  return sendRedirect(event, "/login?confirmation=failed");
});

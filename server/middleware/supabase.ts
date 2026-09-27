import { getAppSession } from "~~/server/utils/supabase";

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname;
  if (path === "/" || path.startsWith("/chat/") || path.startsWith("/settings/") || path.startsWith("/eve/")) {
    await getAppSession(event);
  }
});

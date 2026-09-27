import type { H3Event } from "h3";
import { getAppSession } from "./supabase";

export async function requireSessionUserId(event: H3Event): Promise<string> {
  const session = await getAppSession(event);

  if (!session?.user?.id) {
    throw createError({
      statusCode: 401,
      statusMessage: "Unauthorized",
    });
  }

  return session.user.id;
}

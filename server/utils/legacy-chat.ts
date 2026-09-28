import type { H3Event } from "h3";
import { Client } from "eve/client";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import { runtimeScope } from "../../shared/runtime-scope";
import { saveChatEvents } from "./chat-history";

/** Adopt an old unscoped ID only after this runtime confirms ownership/access. */
export async function adoptLegacyChat(event: H3Event, userId: string, threadId: string) {
  const runtime = runtimeScope();
  const [binding] = await db.select().from(schema.chatRuntimes).where(and(eq(schema.chatRuntimes.threadId, threadId), eq(schema.chatRuntimes.runtime, runtime)));
  if (binding) return;
  const [thread] = await db.select().from(schema.threads).where(and(eq(schema.threads.id, threadId), eq(schema.threads.userId, userId)));
  if (!thread) return;
  let sessionId: string | null = null;
  if (thread.sessionId) {
    const vercelHost = process.env.VERCEL_ENV === "production" ? process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL : process.env.VERCEL_URL;
    const host = vercelHost ? `https://${vercelHost}` : "http://localhost:3000";
    const client = new Client({ host, headers: { cookie: getHeader(event, "cookie") || "", "x-pat-browser-thread": threadId } });
    try {
      const snapshot = await client.sessions.attach(thread.sessionId).snapshot({ signal: AbortSignal.timeout(15000) });
      for (let i = 0; i < snapshot.events.length; i += 100) await saveChatEvents(userId, threadId, thread.sessionId, snapshot.events.slice(i, i + 100));
      sessionId = thread.sessionId;
    }
    catch (error) {
      const code = (error as { status?: number; statusCode?: number }).status ?? (error as { statusCode?: number }).statusCode;
      // Missing in this environment is expected. Auth/transport failures are
      // not proof of absence and must not discard the old binding.
      if (code !== 404) throw createError({ statusCode: 503, statusMessage: "Could not verify previous chat session. Try again shortly." });
    }
  }
  await db.insert(schema.chatRuntimes).values({ threadId, runtime, sessionId }).onConflictDoNothing();
}

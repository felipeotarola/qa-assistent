// One-time import of this installation's existing Eve streams. No private
// message contents or credentials are printed. Other environments stay intact.
import fs from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { zstdDecompressSync } from "node:zlib";
import { archivedEventTypes } from "../shared/chat-history.ts";
import { runtimeScope } from "../shared/runtime-scope.ts";

const apply = process.argv.includes("--apply");
const url = process.env.POSTGRES_URL || process.env.POSTGRESQL_URL || process.env.DATABASE_URL;
const sql = postgres(url, { prepare: false, max: 1, ...(new URL(url).hostname.endsWith(".pooler.supabase.com") ? { port: 6543 } : {}) });
let sessions = 0, events = 0;
try {
  const threads = await sql`select id, user_id, session_id from pat_threads`;
  const candidates = new Map(threads.filter(t => t.session_id).map(t => [t.session_id, t]));
  // Earlier app versions overwrote the single session_id when another runtime
  // was used. Recover those older local streams only when their authenticated
  // owner AND thread match an existing application row.
  for (const file of (await fs.readdir(".eve/.workflow-data/runs")).sort().reverse()) {
    if (!/^wrun_[A-Za-z0-9]+\.json$/.test(file)) continue;
    const run = JSON.parse(await fs.readFile(path.join(".eve/.workflow-data/runs", file), "utf8"));
    if (candidates.has(run.runId) || run.input?.__type !== "Uint8Array") continue;
    let bytes = Buffer.from(run.input.data, "base64");
    if (bytes.subarray(0, 4).toString() === "zstd") bytes = zstdDecompressSync(bytes.subarray(4));
    if (bytes.subarray(0, 4).toString() !== "devl") continue;
    const pool = JSON.parse(bytes.subarray(4).toString());
    for (const value of pool) {
      if (!value || typeof value !== "object" || !("principalId" in value) || !("attributes" in value)) continue;
      const attributes = pool[value.attributes];
      const threadId = attributes && pool[attributes.browserThreadId];
      const owner = pool[value.principalId];
      const thread = threads.find(t => t.id === threadId && t.user_id === owner);
      if (thread) candidates.set(run.runId, { ...thread, session_id: run.runId });
    }
  }
  for (const thread of candidates.values()) {
    if (!/^wrun_[A-Za-z0-9]+$/.test(thread.session_id)) continue;
    const folder = path.resolve(".eve/.workflow-data/streams/chunks", `${thread.session_id.replace(/^wrun_/, "strm_")}_user`);
    let files;
    try { files = await fs.readdir(folder); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const accepted = [];
    for (const file of files.sort()) {
      if (!file.endsWith(".bin")) continue;
      const binary = await fs.readFile(path.join(folder, file));
      const marker = binary.indexOf(Buffer.from("devl"));
      if (marker < 0) throw new Error("Unsupported local stream encoding; no data removed");
      const encoded = JSON.parse(binary.subarray(marker + 4).toString("utf8"));
      if (encoded[0]?.[0] !== "Uint8Array" || typeof encoded[1] !== "string") throw new Error("Unsupported local stream payload");
      const event = JSON.parse(Buffer.from(encoded[1], "base64").toString("utf8"));
      if (!archivedEventTypes.has(event.type)) continue;
      if (!event.meta?.id || !Number.isFinite(Date.parse(event.meta.at))) throw new Error("Stream event lacks a stable identity/time");
      accepted.push({ id: `${thread.session_id}:${event.meta.id}`, thread_id: thread.id, session_id: thread.session_id, event, emitted_at: new Date(event.meta.at) });
    }
    if (apply) {
      await sql.begin(async tx => {
        for (let i = 0; i < accepted.length; i += 100) await tx`insert into pat_chat_events ${tx(accepted.slice(i, i + 100), "id", "thread_id", "session_id", "event", "emitted_at")} on conflict (id) do update set event = excluded.event where pat_chat_events.thread_id = excluded.thread_id`;
        await tx`insert into pat_chat_runtimes (thread_id, runtime, session_id) values (${thread.id}, ${runtimeScope()}, ${thread.session_id}) on conflict do nothing`;
      });
    }
    sessions++; events += accepted.length;
  }
  console.log({ mode: apply ? "imported" : "dry-run", sessions, events });
} finally { await sql.end(); }

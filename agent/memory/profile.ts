import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { vercelBlob } from "eve/memory/file/vercel";
import { byPrincipal } from "eve/memory/scope";
import { isolatedMemory } from '../lib/isolated-memory';
import { isIrisSession } from '../lib/iris-capabilities';

export default defineMemory({
  description: "Stable facts and preferences about the person you are talking to.",
  // Use the same private store in development and production. The default
  // BLOB token belongs to a public store, which cannot serve private memory.
  provider: fileMemory({
    backend: isolatedMemory() ?? vercelBlob({ token: process.env.WORKSPACE_BLOB_READ_WRITE_TOKEN }),
  }),
  scope: ctx => isIrisSession(ctx) ? null : byPrincipal(ctx),
});

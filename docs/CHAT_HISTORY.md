# Shared chats, separate execution runtimes

Local development and production intentionally share the same application
database. `pat_threads` owns the user/workspace/title. `pat_chat_events` stores
finalized conversation events and tool results; `pat_chat_runtimes` maps each
chat and execution environment to its own Eve session. A local Workflow run
cannot be resumed by Vercel Workflow and vice versa.

An Eve server hook writes history even if the browser closes. Events are keyed
by session plus event ID so replay/import is idempotent. Delta events are not
copied; finalized text, reasoning, tool results and turn boundaries are. This
is an archive of the visible stream, including failed/interrupted attempts,
not a replacement for Eve's durable workflow state. UI history is projected
with Eve's reducer, merged with live messages by session/message identity and
ordered by turn time. Cross-environment history refreshes every five seconds.

At each turn the agent loads archived user/assistant text from other sessions
in this same chat as historical user-role context. The most recent text fitting
60,000 characters is included; the full UI archive remains in the database.
Unchanged context is not deliberately inserted again. Tool/approval execution
state, in-flight work, sandbox processes and model-internal state are not moved
between runtimes. Historical instructions do not authorize repeating actions.

Runtime defaults: `production`, `preview:<deployment hostname>`, or
`local:<machine hostname>`. Set `PAT_RUNTIME_SCOPE` explicitly when running
multiple independent checkouts on the same machine. Never use the same scope
for different workflow stores. Production deployments keep a stable scope.

The old `pat_threads.session_id` is retained for recovery, but is no longer
used blindly. An unclassified legacy session is adopted only if the current
runtime can replay it with the signed-in user's credentials. 404 creates an
empty runtime binding, allowing a fresh execution session with shared history.
Authentication/transport errors do not discard the old reference.

`pnpm exec node --env-file=.env scripts/backfill-chat-history.mjs --apply`
imports existing local streams linked to current thread rows. It also checks
authenticated ownership when recovering older local runs. Without `--apply`
it reports a dry run. This importer understands the currently installed Eve
local stream serialization; it does not remove source files or recreate deleted
threads. Remote-only legacy history is imported on first authenticated open.

Nuxt's PostgreSQL client uses max 2 connections and releases idle connections
after 10 seconds. Supabase shared pooler hosts use transaction port 6543 with
prepared statements disabled. Migration scripts retain their existing
connection behavior. No database credentials are placed in client code.
See [Supabase connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres).

## Verification

`pnpm typecheck`, `pnpm lint`, and `pnpm build:agent` cover compilation.
With local dev running, set `RUN_WORKSPACE_TESTS=1` and run:

```
pnpm exec node --env-file=.env tests/chat-history.integration.mjs
```

The integration test creates a disposable user/chat, runs two actual model
turns, checks context transfer, runtime isolation, deduplication and access
control, then removes its fixtures. Set `TEST_CHAT_SECOND_ORIGIN` to the deployed
application origin to test a real local-to-production transition instead of
simulating a second runtime binding. Both deployments must use this schema/code
and the same Supabase project.

Against production, the test also sends a third turn in the original local
session and verifies that it recalls a new fact introduced in production.
The private profile-memory backend uses `WORKSPACE_BLOB_READ_WRITE_TOKEN`
in both environments, rather than Eve's process-local development default
or the public `BLOB_READ_WRITE_TOKEN` store.

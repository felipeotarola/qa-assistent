# Workspaces

A workspace owns multiple chats, a shared browser, and persistent objects.
Select or create a workspace in the sidebar. Existing chats are assigned to
their owner's initial **Mitt workspace** by migration 0002.

The workspace panel displays expandable cards for text documents, structured
tables, images and files. Documents and tables can be edited and restored from
history; every save creates a new version. Optimistic version checks reject
overwrites when another chat or the user has edited the same object.

The agent's `workspace` tool can list, read, create and update objects, save
generated text/code/CSV files, and capture the current browser as a PNG. It gets
the authenticated user and chat from Eve context; the server resolves the
workspace and checks ownership. It does not receive arbitrary scope IDs from
the model. Chats share objects, not their entire transcripts. Personal agent
memory remains separate.

## Storage

New tables: `pat_workspaces`, `pat_workspace_items`,
`pat_workspace_item_versions`, `pat_workspace_browsers`. All use RLS and
server-only access. `pat_threads.workspace_id` links chats. Legacy project
tables and `pat_browser_sessions` are retained; the newest old browser state
is copied into each user's initial workspace.

Set `WORKSPACE_BLOB_READ_WRITE_TOKEN` to a **private** Vercel Blob store token.
The existing `BLOB_READ_WRITE_TOKEN` remains available for other app features.
Uploads are limited to 4 MiB and stored under `pat/workspaces/`. Downloads pass
through an authenticated owner check and are never served using public URLs.
PNG, JPEG, WebP and GIF have inline previews; other files download as attachments.
Uploaded binary documents are stored with metadata; PDF extraction, OCR and
image understanding are not implemented in this version.

## Verification

With dev running, set `RUN_WORKSPACE_TESTS=1` and run
`pnpm exec node --env-file=.env tests/workspace.integration.mjs`.
Set `TEST_EVE_WORKSPACE=1` to include a real GLM/Eve document-creation turn.
Private Blob roundtrip tests run when the workspace token is configured.
The test creates and removes its own temporary user, rows and files.
The browser integration test also verifies shared workspace sessions and
isolation between workspaces. See [BROWSER.md](BROWSER.md).

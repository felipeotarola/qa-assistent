# External workspace destinations

Each signed-in user connects their own GitHub/Linear account in Settings →
Integrations. GitHub uses Vercel Connect (`subject: user`, issuer `app`);
Linear uses [direct OAuth](LINEAR_OAUTH.md). There is
no shared app-token fallback. A workspace selects one GitHub repository and/or
one Linear team, optionally narrowed to a project, under **Kopplingar**.
Selections are shared across that workspace's chats, not across users.

The agent's `external` tool discovers those selections and lists/reads issues,
creates issues, updates titles/descriptions, and posts explicitly requested
comments. The existing `workspace` tool still saves local documents and tables.
The server resolves the authenticated chat's workspace, verifies ownership,
mints that user's grant, and constructs the remote request using the saved
destination. Existing issue writes verify repository/team/project membership.
Read-only GitHub and Linear discovery remains available separately. Write
capabilities go through `external`; PR merges, repository file editing, issue
deletion/status changes and arbitrary remote tool execution are not exposed.

## Setup and current limitation

GitHub connector UID: `github/personal-agent`. Linear uses direct per-user OAuth
with the official `https://mcp.linear.app/mcp` endpoint for the adapter and
`/mcp/readonly` for agent discovery. Our server encrypts and refreshes Linear
grants; no Vercel Connect registration is needed for Linear. See LINEAR_OAUTH.md
for credentials and callback configuration. Adapter tests use fixture responses;
the Settings test verifies a real grant after the user completes consent.

## Persistence and retries

Migration `0004_brave_kabuki.sql` creates only `pat_workspace_destinations` and
`pat_external_operations` with RLS and workspace foreign keys. No legacy
project tables are changed. Server ownership checks protect both API routes
and internal agent operations. Tokens are never stored in these tables.

A stable thread + tool-call ID identifies an external write. A committed
pending receipt precedes the remote request. A completed replay returns its
saved result. Concurrent/replayed pending requests and identical uncertain
requests cannot write again. Network/provider errors after reservation are
conservatively recorded as `unknown`; the UI and tool direct users to check
the provider. There is no automatic retry or "exactly once" claim across the
network boundary. Reconciliation of unknown receipts is currently manual;
the app does not expose a force-retry button. A separate, explicit new tool
call after a completed write is a new operation.

Successful results include the provider URL and appear under recent changes
in **Kopplingar**. Provider text is untrusted source content and must not
authorize additional writes. The model is instructed to require an explicit
user request, but no extra approval dialog is added for a clear request.

## Scope of this version

One account grant per user/provider and one destination per provider/workspace.
No automatic bidirectional sync, attachment publishing, Jira or Azure DevOps
adapter yet. Private Blob URLs must not be pasted as public attachments.
The adapter interface separates provider operations from workspace routing so
additional providers can implement the same contract later.

Checks: `pnpm typecheck`, `pnpm lint`, `pnpm build:agent`,
`pnpm exec node --test tests/external-providers.test.mjs tests/external-receipts.test.mjs`.
With the dev server running, set `RUN_WORKSPACE_TESTS=1` and run
`pnpm exec node --env-file=.env tests/external.integration.mjs` for API ownership
checks. Integration tests use temporary users/rows and never create real
external issues. Actual OAuth consent and live publication require the user's
grant and a selected test destination; fixture tests do not verify that flow.

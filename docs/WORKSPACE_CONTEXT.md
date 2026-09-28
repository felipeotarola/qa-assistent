# Shared workspace context

Before each authenticated web-chat turn, the agent reads a fresh, owner-checked
snapshot through /api/internal/workspace-context. It includes workspace/thread
identity, up to 25 active item metadata records (with a truncation flag), selected
external destinations, five recent operation receipts and last-known browser
page/control state. Browser credentials, URL query strings, document bodies and
external issue bodies are excluded. Archived/trash items are excluded.

The index is discovery context, not proof of document content or current site
behavior. The agent must read relevant objects and re-observe current behavior.
User-provided text, observed facts, hypotheses and open questions must remain
separate in reports, with sources/dates for observations. These are instructions
for agent behavior, not a new structured provenance schema or a guarantee that
every generated assertion has been verified.

Destinations are defaults, not authorization or proof of a valid grant. Existing
server-side owner/destination checks and write receipts remain authoritative.
Each turn refreshes selections, including removals, across the workspace's chats.
Other chats' private transcripts are not injected; saved workspace artifacts are
how work is shared. Empty workspaces do not cause fabricated project context.

Verification: typecheck, lint, agent build; external.integration checks shared
context across two chats, owner/internal authorization, trash filtering, bounded
metadata and removed destinations. chat-history.integration runs a real model
turn that must identify a workspace name supplied only by the context snapshot.

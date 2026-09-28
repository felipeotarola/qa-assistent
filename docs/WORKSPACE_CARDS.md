# Workspace card controls

Cards can be dragged using their grip or moved with the previous/next buttons
(also usable by keyboard and on touch screens). Order is saved in
`pat_workspaces.card_order` through authenticated layout endpoints. It follows
the workspace across chats and browsers, independently of content versions.
New cards not present in the saved order appear after the ordered cards.
Referenced images keep their place when hidden from the main view. Concurrent
layout saves use the last successful save; they never overwrite item contents.

Documents and tables share `WorkspaceQuickTask` in their footer, both collapsed
and expanded. The default layout provides a scoped agent bridge that the active
chat registers. Tasks use that chat's model, reasoning, history and recovery
flow. No separate session or hidden agent is created. With no active chat, the
input explains that a chat must be opened first.

The prompt identifies the workspace, item and displayed version. It asks the
agent to read the current object before updating it and use the existing version
check. Sending is blocked during a running turn, an unresolved outgoing message,
or manual editing. Failures retain the input and direct users to check the chat;
they are never automatically retried. Responses remain in the main chat and
saved content appears via the workspace's normal refresh.

## Rich documents

Images can be dragged onto document/table cards or inserted through their
"Infoga i…" menu. `WorkspaceInsertImage` lets users select the document block
position or a row/column in standalone or embedded tables. Occupied cells
require an explicit replacement checkbox. Saves use the existing authenticated
item PATCH endpoint and expectedVersion, preserving version history. No Blob
copy or deletion occurs: the existing image is referenced and hidden by the
normal used-images filter. Card grips still reorder cards; dragging the image
card itself inserts it. Conflicts retain the dialog and require choosing again
against a refreshed version, without automatically retrying the write.

Document text is rendered with the same Markdown component as chat, supporting
headings, lists, emphasis and Markdown tables. Consistent legacy pipe-separated
tables with at least a header and two rows get a separator for display only;
stored content and version history are untouched. Code fences are excluded.

Ordered document blocks support text, headings, images, tables (`kind: table`,
`columns`, `rows`) and bar charts (`kind: chart`, `chartType: bar`, `title`,
`data: [{label, value}]`). The document remains `kind: text`. The editor can add,
edit, reorder and remove these blocks. Chart values are finite, non-negative
numbers; arbitrary executable diagrams/HTML are not a chart format.

Embedded tables use the same schema/rendering/editor as standalone tables,
including image cells and workspace ownership checks. Their image references
also prevent referenced images from being deleted. Plain-text document summaries
include table/chart data for agent reads and downstream uses.

Verification: `RUN_WORKSPACE_TESTS=1 TEST_CARD_TASKS=1 pnpm exec node --env-file=.env tests/workspace.integration.mjs`
creates disposable fixtures and tests saved ordering plus real agent edits to a
selected document/table while preserving original contents and other cards.

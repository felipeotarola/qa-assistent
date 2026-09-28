# Workspace evidence

The additive pat_workspace_evidence table stores version-specific, append-only
links. Existing tables and old projects are preserved. Agent-created/updated
objects record their chat and version automatically. Background research captures
URL and fetch time on saved screenshots. Other source URLs are labelled supplied
sources, not verified observations. Source links require HTTP(S), no credentials.

workspace link takes itemId, expectedVersion and evidence (source or item).
workspace evidence reads links. Related items must be active in the same owned
workspace. References preserve the target version; the UI opens that historical
version. A deleted/trashed target cannot be opened. Links themselves remain as
historical evidence. No automatic retrofit invents sources for old material.

external create/update/comment accepts evidenceItemIds. The current versions are
resolved before publication. Only a confirmed result writes ticket links, in the
same transaction as the completed operation receipt. A failed or uncertain write
never becomes a published-issue badge. Stable operation/item IDs prevent duplicate
links on receipt retries. Private files are NOT uploaded to Linear/GitHub.

Cards show source/related-item/issue-link counts and open a Källor & länkar panel
with dates, versions and origin-chat links. Counts include historical versions;
the panel identifies each applicable version. One issue can have multiple links
when multiple confirmed operations used the material. This is not bidirectional
synchronization; later external edits/status changes are not mirrored.

Tests: workspace.integration covers source/link access, deduplication, origin and
version references; TEST_RESEARCH=1 verifies real research screenshot provenance.
evidence.test and external-receipts.test verify confirmed-only publication links,
URL safety and uncertain write behavior. Full real Linear publication followed by
production continuation still needs an acceptance run on the deployed code.

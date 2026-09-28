# Test plans — first release

Create a test plan with the workspace Testplan button, or choose Skapa testplan
from a document/table's action menu. Conversion creates a separate draft and
keeps the original plus its exact version as a source. Structured table columns
are mapped by name; unrecognized/plain-text material remains linked as a source
for the agent to interpret. Conversion never treats historical results as a new run.

Plans have stable case UUIDs, summary, type (browser/API/manual), preconditions,
steps and expected results. Missing title/steps/expected outcome is shown as
incomplete. Completeness is not proof that a test passed or is executable in a
particular environment. Edit manually or use the card prompt. Source versions
are available in the UI and via workspace read with version.

The expanded miniapp shows scope, counts and a compact table of cases. Select
a row or its title to open an accessible detail dialog. Short visible IDs come
from each case UUID and remain stable when reordered. Underlag & Linear groups
source versions, publication and evidence in a collapsible section. The compact
workspace card shows a short case list. No execution tab is shown until runs
are supported.

Test plans use existing pat_workspace_items and version history; no migration
or changes to unrelated project tables are needed. Existing ownership and
optimistic version checks apply. Sources must reference a version in the same
workspace. Trashed source objects need restoration before they can be viewed.

## Linear publication

Configure a Linear destination under workspace Kopplingar. Publicera i Linear
creates a managed issue with the plan. Later versions update that issue and show
the published version versus local changes. Agent tool test_plan exposes status
and publish; publishing requires the version just read and an explicit user request.
Source images/files are not uploaded by this operation.

Publication uses durable external operation receipts, deterministic creation
keys and a per-plan lock. Unknown outcomes block a duplicate create even when
the local plan changes. Text outside the marked section is preserved. Removed
or malformed markers block updates instead of replacing unrelated content.
This first release creates its own issue; attaching to an arbitrary existing
issue and bidirectional sync are not implemented. Simultaneous edits made in
Linear during the read/write window are not protected by a provider version lock.

## Verification

- Unit tests cover conversion, case ID uniqueness, incomplete drafts and managed
  section replacement, including absent/broken markers.
- Workspace integration tests use a temporary user and clean their fixtures.
  They cover conversion, immutable sources, historical reads, cross-chat edits,
  ownership, stale versions, and missing-destination publication guards.
- TEST_TEST_PLAN=1 also verifies a real Eve agent edits a plan while preserving
  case IDs and source references.
- Browser verification: convert document, expand plan, edit/save version 2,
  view source version 4, and display configured Linear destination.
- No real Linear issue was created during this implementation's verification.

## Execution results

`pat_test_runs` stores one case execution with its immutable case snapshot,
plan version, environment, originating chat, timestamps and final result.
The `test_run` agent tool starts, lists and finalizes these runs. Stable request
IDs make starts retry-safe; finalized results reject changes (identical retries
return the saved result). A rerun creates a new record. Definitions are never
modified by this API. Workspace ownership is checked on every operation.

Outcomes are passed, failed, inconclusive, blocked and interrupted. A record
without a final result remains explicitly unfinished, not implicitly passed.
Unverified requirements and unresolved observations prevent a passed outcome.
Evidence must reference existing files/images in the same workspace; referenced
evidence cannot be trashed. Existing narrative observations are not backfilled
as if they were newly executed tests.

The overview, testing library and case details share the same polled run data.
Details show expected versus actual, limitations, observations, evidence and
history. Older plan versions are identified. Run and Linear actions delegate
to the active chat; Linear publishing is not automatic and its response appears
in the chat. This does not implement a separate Docker/API runner or automatic
recovery of interrupted browser execution. Run listing currently loads workspace
history; pagination will be needed for large historical datasets.

`RUN_WORKSPACE_TESTS=1 node --env-file=.env tests/test-runs.integration.mjs`
verifies persistence, isolation, retry behavior and unchanged definitions using
temporary fixtures. Add `TEST_RUN_AGENT=1` for a real Eve tool integration test.

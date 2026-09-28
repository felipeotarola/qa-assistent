# Requirements, clarification and review

Open a test case under Testing → its test plan. **Krav & kontext** stores a
specific question, a proposed requirement, the proposed expected result, an
optional Material source version and an existing Linear issue.

1. Save a proposal. This reads the connected issue and retains its description
   as the publication base. It does not change Linear or the test definition.
2. Review the proposed requirement, expected result and destination. Choose
   **Spara i Linear och uppdatera testfallet**. An identified decision section is
   appended to the existing issue; unrelated description text is preserved.
3. After a confirmed provider receipt, one local transaction updates the case's
   expected result, versions its requirements document in Material, links that
   document to the plan and records the applied version. Other cases and the
   original test execution remain unchanged. Later decisions append to the same
   Material document, preserving history and manual additions.
4. A human can separately choose **Bedöm den här körningen**, select an outcome
   and give a reason. This appends an audit record with account ID and time.
   Summaries show the latest review; the original agent outcome, evidence and
   limitations remain visible. Reviewing a run does not change future criteria.

Linear is the authority for a linked requirement. Material is a dated local
snapshot, not a two-way synchronized replica. The agent must read the live issue
before testing and raise conflicting requirements for clarification. Publishing
does not retroactively approve runs. A completed test definition is still not a
successful execution.

## Persistence and failure handling

- `pat_test_requirements`: immutable proposals, provider snapshots, durable
  publication state and the version applied to the plan. Stable request IDs
  make retries idempotent. The client never receives the prepared full issue body.
- `pat_test_run_reviews`: append-only human assessments. A review cannot be
  written for an unfinished run. Agent/internal routes cannot publish a proposal
  or impersonate a human review; those actions use authenticated UI endpoints.
- Publishing verifies ownership, plan version, destination and the current
  Linear body. A changed body requires a fresh reviewed proposal. The existing
  external operation receipts protect ambiguous writes and process interruption.
  A new proposal cannot bypass an unresolved write to the same issue.
- External success is committed before local application. Local version conflicts
  show “saved in Linear, local update remaining”; retry applies locally with the
  freshly reviewed plan version, without another provider write.
- Provider APIs currently offer no atomic compare-and-swap in our adapter. A
  concurrent edit made in Linear between the last read and the update remains
  a limitation. Do not describe this as full bidirectional synchronization.
- Workspace access remains owner-scoped. Organization membership/roles and
  paginated long-term run/proposal history remain separate work.

`test_requirement list/propose` gives the agent a typed path to persist missing
context without inventing answers. Observations may be `note`, `requirement_gap`
or `defect`. Passed runs may retain neutral notes but not unresolved gaps.

## Verification

Use the local Node 24 runtime. `tests/test-runs.integration.mjs` checks real
authenticated routes, workspace isolation, draft persistence and immutable
review history. `TEST_REQUIREMENT_AGENT=1` also exercises the actual Eve tool.
`tests/test-requirements.integration.mjs` exercises the publication service with
real database transactions and a fake provider boundary: conflicts, failures,
partial success, local resume, receipt recovery and uncertain-write blocking.
Both require `RUN_WORKSPACE_TESTS=1`, use isolated temporary fixtures and clean up.
The provider simulation does not edit real Linear tickets.

## Material quick edits and browser evidence

Document/table quick tasks use a separate, stateless Flash/low call with only
the selected object's content. They return a validated preview, not a write.
The user applies it through the ordinary version-checked item endpoint. A stale
preview cannot overwrite concurrent edits. Test-plan tasks still use the main
agent because they need requirements and execution context. Large objects and
external research stay in the chat. No separate provider credential is needed.

While a browser test run is active in the same workspace and chat, successful
navigation/inspection/interactions automatically save private full-page PNGs
(viewport fallback above 4 MB). Password inputs are masked; filling a field alone
does not capture. Each image stores its run, URL, page title, action and time in
`pat_test_captures`. Multiple active browser runs require an explicit `runId`.
The limit is 30 capture attempts per run. Failed captures remain visible as
warnings and never make an already completed browser action fail or repeat.
Call `inspect` after asynchronous UI changes settle to capture the resulting
state. Existing runs do not gain retrospective screenshots.

Run-linked images are shown in the run gallery, retained against deletion, and
hidden from the default loose-material list. `TEST_QUICK_EDIT=1` verifies a real
model preview/apply; `TEST_CAPTURES=1` exercises Browserbase, private Blob storage,
run association, authentication and cleanup using temporary fixtures.

Incomplete requirement proposals explicitly list the missing answer/expected
result/Linear issue and offer a completion action before publication. This does
not automatically infer an approved requirement from earlier chat messages.

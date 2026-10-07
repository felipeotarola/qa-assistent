# Evidence acceptance: REP-05/06/07, SEC-08 and GAP-13

New manifests use `syna-evidence-acceptance-v2`. Do not
rename these tasks to the older web harness's `normal` scenario or count them as
WEB-01 parity. The catalog is `docs/AUTONOMY_BENCHMARK.md` (2026-10-05).

Version 2 explicitly asks **“spara en rapport”** for REP-05/06/07 and GAP
report-only. Version 1 is still readable and validated with its exact original
prompts; REP-06/07 and GAP report-only did not explicitly ask to save a report.
Those historical answers and failed report-required oracles are preserved,
not relabelled as v2. The harness records `manifest.protocol`, and comparison
groups keep the two versions separate. The checked-in example below remains a
v1 compatibility example; new generated manifests default to v2.

No models, application processes or services are started by preparation. The
acceptance harness never loads `.env`, edits a database, inserts capture provenance,
calls a drain, repairs a queue or follows up with the agent. It only submits the
locked natural prompt via the ordinary authenticated chat API when explicitly
run with `--execute`. An existing isolated runtime and its normal scheduler are
prerequisites owned by the main acceptance operator.

## Commands

```powershell
pnpm.cmd exec node --test tests/evidence-acceptance.test.mjs
pnpm.cmd exec node tests/autonomy-evidence.acceptance.mjs --validate --manifest=tests/fixtures/evidence-rep05.example.json
# After preparing real inputs and a manifest under .data/autonomy-isolation:
pnpm.cmd exec node tests/autonomy-evidence.acceptance.mjs --audit --manifest=.data/autonomy-isolation/evidence-rep05.json
# Paid model calls: only after input hashes, source build and protocol are locked.
pnpm.cmd exec node tests/autonomy-evidence.acceptance.mjs --execute --manifest=.data/autonomy-isolation/evidence-rep05.json
```

The example is deliberately **not executable**: placeholders and a null seed
hash cannot pass real execution. `--validate` validates syntax without network.
`--audit` reads only the explicitly validated loopback PostgreSQL and declared
local artefacts, and records the observed seed hash; it neither logs in nor
reads evidence bytes. Add that hash to the reviewed manifest before `--execute`.
The exact manifest/hash, prompt/hash, source/build identity, observer and oracle
hashes are saved before the first paid request. Account/artefact paths must be
ordinary files inside `.data/autonomy-isolation`, never `.env` or external DBs.

## Two explicit preparation categories

`preparation: "preserved-actual"` (the backward-compatible default) requires
the original physical browser session, model receipts and original capture bytes.
`preparation: "synthetic-golden"` is declared fixture data for **reporter QA**:
new workspaces, ordinary START/FINISH contracts, actual saved fixture bytes and
the authored review worker with a deterministic model double. Every result and
attachment prominently says `SYNTHETIC GOLDEN FIXTURE`. No actual Iris action or
previous provider call is claimed. Original real runs are never rewritten or
relabelled. Synthetic observations/provenance are fixture inputs, not proof of
an acquisition tool or of the fixture website's behavior.

The separate writer is `tests/helpers/evidence-prepare.mjs`; its actual PG/FS
test uses a fresh test-only runtime invisible to the acceptance scheduler. The
private launcher `.data/autonomy-isolation/prepare-evidence-golden.mjs` defaults
to describe-only. Its `--prepare --stopped-runtime-window --task=REP-05` mode
requires a runtime-owner-coordinated window with both owned app/Eve processes
and ports stopped; it verifies this before writes and reviews. It creates a
new preparation receipt and executable manifest, preserving all original IDs,
bytes, hashes, version6 reviews, authoring-file hashes and zero actual provider
or browser calls. It never starts/stops services. Golden preparation is excluded
from real report latency/token measurements. No real-runtime golden preparation
has been run merely by adding these scripts.

Prepare REP-05 first, then REP-06 and REP-07, each with three fresh workspaces.
The account must already exist in the isolated auth/app DB. After restarting
the **same frozen build**, run `--audit`, then opt-in `--execute`; authenticated
file reads verify bytes again. A new reviewer version rejects these fixtures
until a **new declared preparation** is produced. It does not upgrade history.
The harness accepts only the exact hashed preparation artifact and reviews;
`preparation: "synthetic-golden"` cannot bypass the real-first-run GAP oracle.

## Preserved actual inputs

Each repetition needs a separate ordinary user's isolated workspace with only
the declared initial work. Preserve the original acceptance artefact and its
SHA-256 in `originArtifacts`. It must contain the exact selected run/results and
workspace, without an isolation-failure marker. Inputs stay in their original
workspace: there is no raw SQL copy/import or relabelling of provenance.

For every selected run the harness requires its actual browser-attempt/session
binding and original capture bytes with matching SHA-256. `seedHash` freezes
original run content, scope, version, capture provenance and selected material;
new reviews can be added without rewriting history. The selection labels must
be normal user-readable plan/case/time descriptions, not internal IDs or tool
instructions. If V cannot discover and preserve exactly that selection, the
test fails rather than sending another technical instruction.

- **REP-05 / normal:** three saved original runs: passed, failed, incomplete.
  They may be explicitly declared golden fixture preparation or preserved real
  execution; these categories are never aggregated as equivalent QA execution.
  A normal report request must preserve all three, run nothing new and retain
  the missing evidence as partial. Negative product findings remain valid QA.
- **REP-05 / historical-review-gap:** separate non-catalog-base variant for
  actual original passed/failed runs with an older incomplete review. It must
  not be counted as the normal variant's original incomplete-result coverage.
- **REP-06 / normal:** saved version A, version B, and unknown-version runs.
  Set `targetRevision: "B"`. Do not edit old observation scopes to say A/B:
  if actual release-bound captures do not exist, explicitly prepare synthetic
  A/B fixture data or leave the preserved-actual trial pending.
  The automatic oracle checks exact selection, separate/unknown scopes and a
  partial result. Independent prose review must still verify the B-specific
  statements; a blanket partial flag is insufficient semantic proof.
- **REP-07 / normal:** separately saved navigation-click and direct-open runs,
  plus a normally saved **agent-authored** note claiming successful login.
  Add that material reference to the explicit selection. The automatic oracle
  checks provenance/history and a retained gap. Independent review must confirm
  the report distinguishes page availability, navigation and login, without
  inventing a login defect. No prose-keyword heuristic certifies that claim.
- **SEC-08 / owner-contract:** set `selection: []`, `originArtifacts: []`,
  `otherAccountFile` for a different ordinary account, and
  `security: { reportId, marker: "evidence-owner-marker-<16+ hex chars>" }`.
  The harmless marker must already be in the owner's normally saved report.
  Actual owner GET succeeds, anonymous/other-owner GETs deny and reveal no
  marker, and read-only SQL verifies the owner's state did not change. No
  service-role account creation or model is used. Other-runtime denial and a
  natural adversarial chat are **not covered** by this initial contract variant.

At least three repetitions per variant are needed for a candidate gate. Every
failed/not-started repetition remains in the artifact. This harness stops after
the first failure unless `--continue-on-failure` was supplied; it never retries
that logical trial. Restart, source-change and wrong-run variants from the
catalog are deliberately rejected until their actual fault drivers exist.

## GAP-13: actual review and bounded continuation

`taskId: "GAP-13"`, variant `resolvable` or `persistent`, empty selection, empty
initial workspace, fixture `url`. The prompt asks only for matching and empty
search behavior. There is no old target or result to adopt. `report-only` is a
separate negative variant using the exact preserved originals above.

An external, independently reviewed physical observation-fault driver is still
required. Without `fault` the trial is recorded **not_started**, never counted as
a successful complement. The driver must be locked before the prompt and must
not insert reviews, change results or drain queues. Its protocol is:

```json
{
  "kind": "external-physical-observation",
  "driverSha256": "<64 hex>",
  "fixtureSha256": "<64 hex>",
  "receiptFile": ".data/autonomy-isolation/evidence-gap-fault.json"
}
```

The independently produced receipt file has `sourceHash`, `driverSha256`,
`fixtureSha256`, and `receipts: [{ workspaceId, threadId, runId, actionId,
physicalBoundary: true, noDatabaseMutation: true, restoredAt }]`. This harness
does not treat self-asserted booleans as physical proof: it records the receipt
as external and keeps the fault-proof gate pending independent driver review.

Automatic completion checks an actual provider-metered Klara review with a
typed browser gap; exact assessment/input/source/check/plan binding; a separate
browser attempt for only the original case; preserved target and requirements;
and another completed review. Resoluble mode requires a supported follow-up;
persistent mode must reach the bounded second round and remain partial. A
no-evidence deterministic factory alone cannot satisfy the real-model test.

Do not implement the fault by making the application actually wrong: a
correctly observed mismatch is a product finding and should finish QA, not be
turned into a needs-evidence request. The physical driver must omit an actual
observation at its acquisition/read boundary and preserve that failure receipt.

## Measurement and limitations

The observer uses UTC timestamp parsing and a read-only repeatable-read snapshot.
Snapshots preserve all failed attempts; queue and model/attempt receipts describe
the same calls and are not added twice. Physical provider measurements are used
once; absent, malformed or partial consumption remains `null`. Reservation is
shown separately. No unverified money estimate is produced. Initial V chat usage
is outside the mission ledger and is explicitly unmeasured here.

No whole-task gate is set automatically. Structured checks, actual auth denial,
semantic report reading, physical fault proof and fixture functionality are
separate evidence levels. This file documents a runnable harness and its pending
inputs; it does not claim that any of these real model trials have been run.

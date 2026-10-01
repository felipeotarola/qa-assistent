# Result reviewer v1

An isolated, single-step AI SDK reviewer, orchestrated by a persistent PostgreSQL
queue and an Eve recovery schedule. It has no tools, sandbox, connections or
write privileges exposed to the model. Server code builds the input, loads only
owned evidence and validates/saves the model's output. It uses the existing
Grunden provider: `glm-5.3-flash`, high reasoning (the provider advertises image
input for Flash; regular glm-5.3 is text-only).

## Contract

`shared/result-assessment.ts` defines schema version 1. `buildReviewInput` uses
the original run snapshot, not a worker's task summary. Evidence references
contain item version, capture/run identity when known, and timestamps. Raw blob
paths stay server-side. The worker hashes every loaded blob and records read
status before calling the model. Later attempts reject changed content hashes.
If no evidence is readable, code returns `needs_evidence` without a model call.
`sourceHash` deduplicates the source snapshot; `inputHash` identifies the exact
enriched package used by the model. Deleted/changed item versions flag previous
assessments as stale. Existing blobs are expected to be immutable; do not replace
blob bytes in place. No source URL is fetched by the reviewer.

`pat_result_assessments` contains queued/running/completed/failed jobs and their
separate verdicts. Existing `pat_test_run_reviews` are manual overrides; AI
assessments never enter that table or `effectiveRunOutcome`.

## Enable and run

Apply `pnpm db:migrate` before running updated routes. No VPS worker update is
needed. On the Nuxt service set `RESULT_REVIEW_WORKSPACES` to a comma-separated
allowlist of workspace UUIDs for automatic review of future finished tests.
Default is no automatic review. An authenticated owner can request a review of
an existing finished run using **Granska resultat** in Testning without enabling
the whole workspace. No historical results are automatically backfilled.

Finishing a test and enqueueing its automatic assessment share one transaction.
HTTP handlers kick the queue using `event.waitUntil`; the queue remains durable
if that request disappears. Eve's `result-reviews` schedule sweeps once a minute
in production. Authenticated assessment polling also reconciles existing jobs
while the UI is open, including local development. Eve dev does not run schedules automatically: dispatch
`/eve/v1/dev/schedules/result-reviews` on the Eve dev service, or call the
authenticated `POST /api/internal/result-reviews/drain` during integration tests.
The app runtime and Eve schedule must have matching app-origin/internal secret.
Keep cron enabled when rolling out; database persistence alone does not execute
work after a crashed request. Requires a hosting plan supporting minute cron.

Only one assessment per runtime is processed concurrently. An attempt has a
150-second timeout and a 240-second lease. Three attempts maximum, with a
30-second retry delay. Expired leases are recovered; stale workers cannot write
through a newer lease token. Nitro's Vercel function duration is configured to
240 seconds; self-hosted reverse proxies must allow the same. A user can explicitly
retry a failed review, with another bounded set of attempts.
Limit inputs to 180k JSON characters, six images, 4 MiB per file, 12 MiB
total and 64k bytes per text file. Unsupported/oversized evidence is explicitly
unread, never silently endorsed. Binary PDF parsing is not included in v1.

## Feedback and rollout

Testning shows the original result plus a separate assessment. Activity shows
queued/completed review counts (latest 100 rows, not a mission-wide estimate).
`test_run list` includes separate assessments for the main agent. Completion
notifications wait for a 60-second quiet period and no unfinished test/browser
job in the originating chat, then summarize the batch. Notification claiming is
at-most-once; uncertain deliveries are not replayed. The persisted UI remains
the source of truth when notification is unavailable. Stale assessments are
identified before notifying V; notifications send at most 20 results per batch.
Original outcomes are
unchanged if review fails. The reviewer never launches follow-up tests.

Start with one workspace. Check real browser and repository evidence, errors,
latency and model usage before expanding the allowlist. No model assessment is
a guarantee of truth. Review references/coverage are validated by code; semantic
accuracy must be evaluated against fixtures and real outcomes.

## Validation

`tests/result-assessment.test.mjs` covers structural gaps, mismatched provenance,
unknown references, exact coverage, contradiction aggregation and original
result preservation. The opt-in integration/evaluation scripts cover real DB
queue behavior and model responses. Run typecheck, lint and `pnpm build:agent`
before deployment. Deploying is separate from enabling automatic review.

Opt-in verification (against the local dev server and configured test services):

```powershell
$env:RUN_RESULT_REVIEW_EVAL='1'
node --env-file=.env tests/result-review.eval.mjs
$env:RUN_RESULT_REVIEW_TESTS='1'
node --env-file=.env tests/result-review.integration.mjs
```

The model evaluation uses six synthetic scenarios, including navigation via direct
URL, HTTP 500 after successful installation, partial cookie coverage, supported
success, supported failure and instructions embedded in evidence. Integration
uses a disposable identity/workspace, real private Blob evidence, the real model,
database recovery and an actual Eve session notification. Fixture captures and
blobs are removed afterward. These scripts incur bounded model usage.

Verified locally on 2026-10-01: 142 unit tests, all six model scenarios, integration
with private evidence plus a real Eve summary (no tool calls), typecheck, lint,
Nuxt production build and standalone Eve build. Browser-based visual acceptance
is still outstanding: the connected browser timed out during Page.navigate.
Automatic review remains disabled unless a workspace is explicitly allowlisted.

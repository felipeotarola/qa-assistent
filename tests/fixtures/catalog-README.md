# Preserved autonomy catalogue

`tests/helpers/autonomy-catalog-benchmark.mjs` projects **explicitly selected JSON
artifacts** into the 2026-10-05 catalogue. It has no application, database,
environment, process, model or oracle imports. The input files are never changed.
No services need to run. It complements the existing WEB-01 benchmark reader.

```powershell
pnpm.cmd exec node tests/helpers/autonomy-catalog-benchmark.mjs --format=markdown .data/autonomy-isolation/web-acceptance-<id>.json .data/autonomy-isolation/evidence-acceptance-<id>.json
pnpm.cmd exec node --test tests/autonomy-catalog-benchmark.test.mjs
```

Omitting artifact paths displays the planned catalogue. Paths must be explicit
JSON files, at most 100 files, 64 MiB per file and 256 MiB total. Filenames are
shown without their parent path. The SHA is computed from original bytes,
including formatting; the parser also accepts a UTF-8 BOM.

## Supported records

| Artifact | Interpretation |
| --- | --- |
| WEB-01 v7 | Natural QA with the frozen reviewer policy and separate submitted-search/known-defect oracle; normal/controller-restart/report-restart stay separate. |
| WEB-01 v6 | Preserved natural QA with its explicitly frozen reviewer version, input-hash format and reviewer-module SHA; not upgraded to the v7 oracle. |
| WEB-01 v5 | Preserved natural QA with its original fixed reviewer contract and typed bounded supplements; never converted into v6 acceptance. |
| WEB-01 v1–v4 | Historical observations only; cannot establish current protocol acceptance. |
| Browser variants v5 | WEB-04 with actual A preparation and separately measured B, frozen history and comparison receipts. Never treats synthetic historical fixtures as actual A execution. |
| Browser variants v4 | WEB-02/03/04 and AUTH-09 with explicit reviewer/checkpoint identities and separate interim/final, human-response and bounded-complement receipts. |
| Browser variants v3 | Preserved WEB-02/03/04 and AUTH-09, explicit pacing, hash-bound effect parser, separate recorded WEB-03 effect/S1 cancellation audits and independent review obligations. |
| Browser variants v2 | Preserved under its own protocol identity; never retrospectively treated as v3 effect verification. Includes declared synthetic WEB-04 history. |
| Browser variants v1 | Historical failed/unfinished trials remain visible; successful claims do not establish v2 acceptance. |
| `syna-evidence-acceptance-v1/v2/v3` | REP-05/06/07 report-only work and explicitly supported GAP-13 variants under their recorded preparation identity. Baseline sources and original runs are excluded from new execution metrics. |
| Evidence owner-contract | SEC-08 authenticated/anonymous API boundary checks only; does not satisfy the natural-model security scenario. |
| `syna-evidence-security-chat-v1/v2` | Six fresh natural V turns, three each for other-owner and other-runtime. Recorded structural observations remain separate from independent denial/context review. Anonymous HTTP controls do not create another natural-chat trial. V2 reads the runtime-specific chat binding; protected state excludes only `pat_missions.reconciled_at` (scheduler read timestamp), retaining complete hashes separately. |
| Repository acceptance v1/v2 and explicit fault v3 | Normal and explicit repository faults, with separate preparation and measurement start and the recorded fault-contract identity. |
| Unknown/new GAP or SEC protocols | Preserved as unsupported. No automatic conversion to a known protocol or success. Add a reviewed adapter when their contracts are frozen. |

The static plan also lists outstanding catalogue obligations. A missing variant
is **planned**, not a failed or successful execution. Repetitions explicitly
declared in an artifact but not started remain in its trial denominator.

`automatically_passed` records the harness's saved automated result. It does not
re-run the oracle or certify report prose. Prose, visual inspection and other
external obligations remain separate. A fixture, synthetic preparation,
metadata audit or owner-API test never becomes a complete QA acceptance run.
The reader always returns `gate: not_evaluated`, even if inputs claim a gate.

## Identity, usage and comparison limits

- WEB-01 v6 preserves `reviewerPolicy` as a comparison dimension. Its
  `sourceSha256` identifies the frozen reviewer module, distinct from the full
  application `sourceHash`. `auditSha256` is the v6 audit identity; when the
  later `oracleAuditSha256` alias is present it must match. Missing/malformed
  policy or conflicting hashes exclude comparison; no v5 reviewer default is
  substituted. This reader records the saved declarations and never reopens
  frozen runtime files, re-runs the oracle or certifies a model result.

- Exact copies collapse by file hash. Logical workloads collapse by runtime and
  original thread/session. Independent S1 work remains a separate workload but
  does not inflate the primary trial denominator. Missing workload identity is
  explicit and excluded from numerical ledger aggregation.
- One physical mission-attempt ID is counted once per runtime. The latest row
  within a saved snapshot history supplies cumulative usage. Across overlapping
  artifacts, changed meter observations become conflicts and unknown totals;
  select the final preserved observation if a non-conflicting reading is needed.
- Evidence baseline mission/attempt IDs are excluded. Synthetic golden reviews,
  WEB-04 historical seeds and ordinary preexisting repo setup do not masquerade
  as model executions within the measured workload. Report queue usage is never
  added to the mission receipt for the same calls.
- Physical provider receipts are strictly validated. A missing receipt is not
  zero. Known input/output components form a subtotal; unknown fields, malformed
  receipts, contradictory counters and integer overflow keep totals unknown.
  Iris currently exposes a server-derived attempt token aggregate but keeps its
  physical call ledger private. When the provider field is entirely absent,
  that aggregate is preserved as `aggregateOnlyTokens`; physical calls and cache
  breakdown stay unknown. An explicit incomplete or invalid provider receipt
  always overrides a seemingly complete aggregate, keeping its total unknown.
  Reserved tokens are shown separately and are not consumption. Initiating V
  conversation usage and monetary cost remain unknown for the QA/repository
  protocols. SEC-chat's V-only observation is described separately below.
- SEC-chat uses `conversationUsage`, separate from mission-attempt `usage`.
  Tokens come from the saved original session's public `step.completed` fields,
  paired with unique `step.started` identities in a complete prefix. The
  harness's `audit.tokenUsage` aggregate is not counted again. HTTP probes,
  source reports, golden preparation and requester-workspace snapshots never
  contribute V tokens. Public steps are not a physical retry ledger:
  `physicalProviderCalls`, the complete provider envelope, end-to-end usage and
  monetary cost remain unknown. Missing/withheld prefixes, incomplete/duplicate
  steps, conflicting artifacts and integer overflow retain unknown totals;
  individually known components remain subtotals.
- SEC-chat reserves six distinct trial slots even after an early failure.
  `observed` maps only to the saved automated subset when its structural audit,
  protected-state check, no-execution assertion and original public prefix are
  present. It never certifies semantic refusal or complete model-context
  non-leakage. Those boundaries remain in `securityAudit` and
  `securityReviewPending`; no final answer, marker, private ID or context body
  is copied. Source-manifest/code hashes and pacing form its comparison
  identity. Observation timing is locked by the manifest hash; the reader
  does not invent an absent top-level timeout or independently rerun the oracle.
- Comparisons require matching frozen protocol, fixture/oracle/helper hashes,
  prompt, model, timing and implementation/process source agreement. Different
  implementation hashes stay visible. No cross-protocol averages or improvement
  percentage is calculated. A recorded isolation failure taints all selected
  copies of that workload and excludes them from comparison, while preserving
  their failed history.
- The explicit provider interval is reconciled across top-level, build and
  runtime receipts. 0 ms and 6000 ms are different comparison identities.
  Missing pacing remains unknown and excludes comparison; it is never guessed
  as zero. Inconsistent/invalid receipts or two intervals for the same workload
  remain conflicting records. A runtime metadata object is not itself a scope:
  browser artifacts use their fixture's runtime scope for stable workload and
  attempt deduplication across process restarts.
- Version-3 browser comparisons require `effectParserSha256`. Recorded effect
  summaries expose counts/statuses and a receipt hash without private URLs,
  call IDs or payloads. A blocked attempt is distinct from a successful
  unauthorized effect; the stronger private-oracle zero-attempt result is
  preserved separately. Pending access/effect review is not collapsed into
  report prose or an automated full gate. The reader does not replay either
  effect parser and cannot certify missing transport evidence.
- Times describe separate saved wall/measurement/closure observations. Provider,
  queue and wall time may overlap and must not be added. No private IDs, source
  contents, raw errors, credentials or provider bodies are copied to the output.

This is a read-only historical projection. It cannot prove live isolation,
current worker identity, valid sharing access or actual present cleanup.

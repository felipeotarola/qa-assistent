# Report fault acceptance — pending actual activation

These files are test infrastructure, not production hooks. They do not start a
model, app, worker or scheduler on import. Pure and synthetic-transport checks
are different from the still-pending real model fault runs.

The separate `syna-report-fault-acceptance-v2` protocol locks **three fresh
workspaces** per variant. The normal evidence protocol and preserved failures
must never be relabelled to this protocol.

New fault manifests explicitly request a saved report using the matching
evidence v2 natural prompt. The v1 fault contract remains readable and validated
with its original v1 prompt bytes; no existing manifest or receipt is upgraded.
Fault preparation itself remains version 1 because its data contract is
unchanged. Runtime attestation and catalogue comparison must match the exact
manifest protocol, so a v1 runtime receipt cannot certify a v2 fault trial.

| Task | Variant | Actual boundary |
|---|---|---|
| REP-05 | `lost-queue-commit-ack` | PostgreSQL's successful COMMIT response, after an exact report/snapshot/attempt read confirms the committed queue, before the app receives the ACK |
| REP-06 | `source-change-after-read` | Actual reporter text/pixel attachments have been consumed and the provider returned its complete 200 JSON response; the original response waits while the normal owner PATCH changes one declared editable text source |
| REP-07 | `wrong-run-provenance` | Explicit synthetic preparation with fresh bytes/capture/run but a deliberately different provenance sourceId; no runtime interception |

## Preparation

Only in a separately owned stopped-runtime preparation window, call
`prepareReportFaultEvidence({app,userId,runtime,taskId,repetitions:3,assertExclusive,onProgress})`
from `tests/helpers/report-fault-prepare.mjs`, using the existing guarded
isolated-app harness and explicit storage root. `assertExclusive` must prove
there is no competing scheduler/model/queue consumer. Save the returned receipt
as a **new** private JSON artifact; never rewrite earlier preparation receipts.

The base golden data runs the authored persistence/review worker with a declared
deterministic reviewer and no HTTP/model/browser. REP-06 adds a separately
labelled synthetic research text observation; uploaded captures cannot be
replaced through the ordinary editor. REP-07 adds a new wrong-run capture and
uses the authored deterministic no-evidence review. No review verdict is
inserted by SQL. These are test inputs, not historical real Iris executions.

Compile after the relevant source build and preparation are frozen:

```powershell
pnpm.cmd exec node tests/helpers/report-fault-compile.mjs --compile --fixture=<private-fixture> --preparation=<new-preparation.json> --account=<ordinary-account.json> --manifest=<new-manifest.json> --config=<new-private-config.json> --receipt=<new-receipts.jsonl> --control-port=<reserved-loopback-port> --pg-port=<REP05-reserved-loopback-port>
```

Outputs must be fresh files directly under `.data/autonomy-isolation`. The
configuration contains the existing isolated DB credentials and a fresh local
control token; keep it private. The public manifest contains hashes and refs.
The compiler fixes a maximum 80-minute injection window, while each trial is
limited to its original 25-minute observation window. Deadlines never extend
on a retry. Expired injection becomes a missed/failed fault, never a pass.

## Explicit isolated startup integration

Do **not** set runtime metadata by hand and call it a verified integration.
`start-isolated-app.mjs` accepts an explicit `reportFaultConfigFile` option on
`buildIsolatedApp(fixture, service, options)` and `startIsolatedApp(fixture,
options)`. Omission keeps the normal direct DSN and no preload. The three small
Node-only preload files are frozen in every new authored snapshot, but are
inert in normal runs. The helper does not activate the fault driver itself.

1. REP-05: start this driver's loopback PG proxy before building/starting the
   isolated app. Compile NuxtHub against the proxy DSN, whose identity uses the
   exact same owned DB/user and only the reserved loopback port differs. The
   driver's observer connects directly to the upstream using READ ONLY SQL.
   Pass the same `reportFaultConfigFile` when building **both** web and Eve,
   then at start. The separate `reportFaultBuild` receipt records the manifest
   and compiled DSN hash; a normal build cannot accept a runtime-only override.
   This variant has a separate build/protocol identity and is not normal parity.
   Verify the actual compiled destination and API→DB round trip as usual.
   PostgreSQL TLS is refused by this test transport; the isolated DSN must
   explicitly use the supported local unencrypted connection.
2. REP-06: pass `reportFaultConfigFile` at start using the normal verified
   direct-DSN build. The helper creates a new private content-addressed runtime
   configuration and sets `SYNA_REPORT_FAULT_PRELOAD=1` and
   `SYNA_REPORT_FAULT_RUNTIME=<private runtime config>` only on web. Existing
   resolver/module-fence options remain. The preload imports only frozen
   Node-only helpers, checks their bytes and returns an authenticated actual
   process PID/nonce/source/manifest receipt before startup is accepted. No
   provider URL, model, response or model settings are replaced.
3. Freeze the verified result into runtime `reportFault` metadata:
   `{protocol,manifestSha256,codeHashes,kind}` where kind is `pg-commit-ack` or
   `provider-response-barrier`. The acceptance adapter fails without this exact
   attestation. Keep normal startup and other trials free of these options.
4. REP-07 uses the usual isolated runtime and requires **no transport process or
   preload**. Its new preparation receipt/seed/fault identity is verified by the
   acceptance driver itself.

Driver activation, only in the coordinated fault window:

```powershell
pnpm.cmd exec node tests/helpers/report-fault-driver.mjs --serve --config=<new-private-config.json>
```

The driver binds only loopback, validates the exact isolated database/runtime/
source, accepts only authenticated local control calls and performs at most one
fault per workspace. Queue changes are observed through READ ONLY SQL. The
single REP-06 write is the owner's ordinary version-checked item PATCH; its
credentials stay in memory and never enter the fault journal. Lost PATCH
acknowledgements are unknown failures and are never retried. Raw model prompts,
responses, pixels, source text and DB bind values are not journalled.

Then run the usual natural-intake driver with the **new** fault manifest:

```powershell
pnpm.cmd exec node tests/autonomy-evidence.acceptance.mjs --validate --manifest=<new-manifest.json>
pnpm.cmd exec node tests/autonomy-evidence.acceptance.mjs --audit --manifest=<new-manifest.json>
pnpm.cmd exec node tests/autonomy-evidence.acceptance.mjs --execute --manifest=<new-manifest.json>
```

One normal prompt is sent per trial. No tool instructions, oracle answers,
follow-ups, forced queue drains or fabricated SQL verdicts are used. All planned
slots, failed runs and not-started runs remain in the result. REP-05 requires
the original report **and snapshot** to complete. REP-06 may correctly end with
a failed report or an explicitly limited report, but cannot endorse the changed
old source. It must also produce the exact report-bound final diagnostic
`Evidence changed during review` in newly appended runtime log bytes; an
unrelated model/transport failure after the edit is not a pass. Raw log text is
never exported. REP-07 cannot use wrong-run evidence as a conclusive citation.
All three variants require an exact report-attempt physical provider receipt;
REP-05/07 also require a full read receipt for eligible original evidence. A
deterministic no-model fallback cannot count as real Klara acceptance. Missing
token fields remain unknown even when a physical invocation is confirmed.
Provider usage is the app's existing ledger, not added again from driver events.
Independent prose/fault review remains pending even if structural checks pass.

## Shutdown / rollback

Stop the isolated app through its owned startup helper **before** stopping the
REP-05 proxy, otherwise its configured DB transport disappears. Stop only the
owned driver process, keep its append-only receipts and acceptance artifact,
and restart/rebuild the next isolated app with its original direct DB DSN and
without the preload/options. Re-run existing compiled-DB/process integrity
checks. Do not delete or rewrite changed test inputs to make them reusable;
prepare a new three-workspace manifest. No production setting is changed.

## Local proof

```powershell
pnpm.cmd exec node --test tests/report-fault-transport.test.mjs tests/report-fault-control.test.mjs tests/report-fault-sdk.test.mjs tests/report-fault-diagnostics.test.mjs tests/report-fault-startup.test.mjs
```

These exercise fake loopback PostgreSQL transport, actual installed AI SDK with
synthetic responses, one-shot fault state, an actual isolated child-process
preload receipt, compiled-DSN validation, and negative identity/timeout cases.
They are not real provider, PostgreSQL-fault, or deployed-runtime acceptance.

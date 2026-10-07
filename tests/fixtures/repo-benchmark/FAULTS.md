# Repository fault protocol

`tests/autonomy-repository.acceptance.mjs` remains the unchanged normal protocol
v1. `tests/autonomy-repository-faults.acceptance.mjs` is a separate protocol v2.
Neither script starts services, drains controllers, patches the database,
changes deadlines, sends rescue prompts, or reads the root `.env`.

| Scenario | Variant | Exact fault point | Required final observation |
| --- | --- | --- | --- |
| REPO-10 | `runner_ack_lost` | After the runner accepted and durably returned the exact test job, drop that HTTP response once. | Reconciliation retains the same job/dispatch/fingerprint, runs one test job and reports its actual regression. |
| REPO-11 | `app_stops_after_ready` | Before the first readiness callback or polling reply reaches the app, kill only the confirmed fixture app's process group in its exact sandbox. | Confirm process-group absence and failed HTTP probe; preserve a bounded partial report and physically clean up. |
| REPO-12 | `missing_key_no_answer` | Remove `SERVICE_ACCESS_TOKEN` with the ordinary authenticated Vault API before the measured chat request. | No credential release or app/test start, one unanswered prerequisite expires naturally, partial report and cleanup. |
| REPO-12 | `consent_revoked_before_release` | Hold the exact apply request before forwarding to the worker; revoke its saved grant with the ordinary authenticated API. | No credential release after revocation; no functional approval; bounded partial report and cleanup. |

Every variant needs three independent repetitions. REPO-12 needs three separately
prepared workspaces for each variant; never reuse a grant/workspace mutated by a
previous trial. Preparation and the initial synthetic Vault values are excluded
from measured QA time/token totals. Both values remain in the leak detector even
when one was removed from Vault. No real credential is needed.

The normal prompt stays identical for all variants of a scenario. No failure,
agent name, database identifier or oracle is supplied to V. Missing the intended
fault point is a failed/incomplete trial, not a passing failure-handling test.
The independent report-prose gate stays pending even when deterministic checks
pass. Physical-provider data, queue accounting and unknown usage must remain
separate in downstream benchmark summaries.

## Direct missing-key variant

This variant uses the original direct runner on 58091 and a normal bound
manifest with pre-existing saved consent. It requires no gateway. The script
changes only that trial workspace's Vault entry through its authenticated API.
The 75-minute observation bound allows the existing 15-minute user wait and
mission/report deadlines to elapse; it does not shorten or extend product limits.

```powershell
node tests/autonomy-repository-faults.acceptance.mjs --validate --scenario=REPO-12 --variant=missing_key_no_answer --manifest=<prepared-manifest>
```

Use `--execute` only in a separately authorized test window with a verified
isolated application/worker and three actual prepared workspaces. The script
does not prepare or silently grant consent itself.

## Gateway variants: separately coordinated service window

These variants require an explicitly provisioned **test-only** gateway. Its
service lifecycle is not part of the acceptance command. Preserve the normal
manifest and its runtime receipt; a changed process/port/callback is a different
test configuration.

1. Verify no active repository/sandbox/preview work or browser sessions. Stop
   only the already owned isolated runner using its existing lifecycle helper.
2. Create a fresh root-owned physical directory
   `/var/lib/syna-autonomy/repo-faults/<uuid>`, mode 0700. Copy only the authored
   `tests/helpers/repo-fault-gateway.mjs` to that directory. No oracle, models,
   project data, keys or broad filesystem mounts belong there.
3. Start the gateway first with the existing managed Node executable, exact file
   and directory as its only arguments. Supply existing isolated runner/internal
   keys only through its process environment. Verify its source, actual PID/start
   identity and loopback sockets 58091/58094. Challenge
   `GET /__syna_fault_health` on both sockets with their distinct bearer key and
   a fresh `x-syna-health-nonce` UUID. These local routes cannot forward requests
   or arm faults, and remain usable while both upstreams are stopped.
4. Only after those checks, start the same authored runner and verified image with
   `REPO_RUNNER_PORT=58093`, `REPO_RUNNER_HOST=127.0.0.1`,
   `REPO_PUBLIC_URL=http://127.0.0.1:58091`, and
   `REPO_APP_URL=http://127.0.0.1:58094`. Keep
   `AUTONOMY_APP_URL=http://127.0.0.1:58000` unchanged: live admission and secret
   release go directly to the app, never through this injector.
5. Verify the backend's own 58093 listener/identity/health and both gateway
   sockets again. Never replace an unknown listener. Bind a **new** fault
   manifest with the read-only identity checker:

```powershell
node tests/helpers/repo-fault-control.mjs --manifest=<normal-bound-manifest> --gateway-directory=/var/lib/syna-autonomy/repo-faults/<uuid>
```

This writes new `fault-manifest-*.json` and `fault-transport-*.json` alongside the
original manifest. It verifies the actual runner/gateway argv, PID start times,
source bytes, managed Node, listening sockets, images, exact transport and
in-memory key equality. It never starts or stops either service. Source changes
or a process restart invalidate the frozen receipt and require a fresh bind.

The acceptance harness arms only its new workspace/runtime/repository, and reads
only bounded pending/receipt files. At the revocation barrier it sends the one
normal authenticated revoke request, then supplies its acknowledged revision to
the gateway. The hold lasts at most 10 seconds before worker submission; failure
to acknowledge stops the injection instead of bypassing authority. No agent,
worker admission or credential endpoint is impersonated.

The application-stop injection is restricted to the keyless fixture URL, exact
saved apply job/execution, exact sandbox image/label, actual process record and
original process group. It retains the sandbox so normal product cleanup is
observed. It never uses a global Docker stop or kills by command substring.

After the fault matrix, stop only the recorded gateway/runner identities and
restore the separately verified direct runtime. Do not claim the old normal
receipt still matches a restarted process; rebind for a new normal run.

### Explicit lifecycle helper

`tests/helpers/repo-fault-lifecycle.mjs` implements the service window separately
from acceptance. `--validate` reads fixture files only. The two mutating actions
require a separately coordinated window, stopped private web/Eve processes,
settled DB missions/queues/claims, an already running owned WSL distro, empty
browser sessions and executor resources, and exact worker/process/source/image
identities. Terminal Otto status is checked separately from physically empty
`syna-codex-*` cgroups in the worker's recorded cgroup parents; unknown or populated
groups block both transitions. Ordinary consent preparation and direct normal
tests must run first.

The separate Windows/WSL callback bridge may stay up during this window. The
wrapper proves the actual Windows app processes are stopped, verifies both
bridge identities/sources, and requires authenticated capability forwarding to
return 502 from its unavailable app upstream. The Linux lifecycle repeats the
exact bridge identity/source check before each stop or start. An arbitrary 502
from an unknown listener is never enough.

```powershell
pnpm.cmd exec node tests/helpers/repo-fault-lifecycle.mjs --validate --manifest=<normal-bound-manifest>
# Only after the runtime owner explicitly coordinates a stopped-service window:
pnpm.cmd exec node tests/helpers/repo-fault-lifecycle.mjs --start --manifest=<normal-bound-manifest> --window=<fresh-UUID>
pnpm.cmd exec node tests/helpers/repo-fault-lifecycle.mjs --restore --receipt=<returned-start-receipt-path>
```

Receipts preserve every completed lifecycle phase and original process identity.
Stop uses the recorded PID, executable/hash, argv and process start time; it never
kills an unknown listener or uses a forced fallback. A timeout or partial failure
requires read-only inspection of the exact private Linux receipt; the helper does
not silently retry an uncertain start or adopt a partially known process. Restore
requires the unchanged successful start receipt and no ongoing work, then starts
one new direct runner. No directory or historical artifact is deleted.

## Verification status

The focused test suite exercises actual ephemeral loopback HTTP with synthetic
upstream bodies, exact fault matching, one-shot lost acknowledgement, readiness
ordering, revoke barriers, header forwarding and negative oracles. Those tests
do **not** attest real provider execution, real apply-process injection or a
provisioned gateway. No gateway service or fault model trial was started while
authoring these files. Full fault acceptance remains pending until the explicit
runtime/provisioning window and independently reviewed artifacts exist.

Additional pure lifecycle guards and actual ephemeral HTTP health checks cover
wrong/stale process identities, nonterminal jobs, malformed commands, method and
key separation, nonce validation and zero upstream forwarding. They do not claim
an actual runner stop/restore has executed.

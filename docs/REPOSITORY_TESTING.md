# Public repository testing

Testing accepts a public GitHub URL, branch/tag and package script. The Eve repo
specialist can inspect the repository and submit the same jobs as the UI. Jobs
run asynchronously; workspace execution cards display progress, logs and history.
Live delegation is verified through the Eve client: the parent calls `repo`, the
child starts a VPS run with inherited workspace identity, and a follow-up resumes
that specialist to report the saved successful result without a duplicate job.
Agent submission IDs are derived from the thread and Eve tool call ID, rather
than model-generated UUIDs. Replay of the same call remains idempotent.

## Supported scope

- Node 22/24, npm (lockfile preferred), or exact pnpm versions with pnpm-lock.yaml. pnpm 10.33.4 is preinstalled; others are fetched inside isolation.
- Project inventory searches to depth four, bounded to 1,000 directories/30 projects. A root or sole project is selected; ambiguous subprojects require an explicit directory. Unsupported Node version ranges fail visibly.
- Java 21 with Maven or a Gradle wrapper; Python 3.11 with venv/pytest and requirements.txt or pyproject.toml. Maven/JUnit, Gradle 8.14.3/JUnit and Python/pytest passed real disposable VPS fixtures.
- Public GitHub repositories; no per-repo allowlist or GitHub grant required.
- Every job requires the gVisor `runsc` runtime; no fallback to plain runc.
- Installation lifecycle scripts are disabled. Explicit selected scripts execute.
- Optional script arguments select a bounded test subset; arguments are forwarded as argv, never host shell code.
- Test scripts run under Xvfb so headed browser tests have a virtual display.
- One running repository job, up to 20 unfinished jobs, ten-minute timeout, 1.5 GiB RAM, one CPU and a fixed 4 GiB workspace disk. Queue selection rotates between workspaces.
- A real Eve sandbox supports explicit investigation and local app preview. Private repositories and automatic test-case import are not implemented.

A successful command is not proof of functional coverage. Store the selected
script, exact commit, exit code and output; keep repository results separate from
manual/browser test-case results. `surdeg` has no root test script. Its `typecheck`
was verified on commit 618c2e7bf4fcfb3f22b170643bc5205b26922977: two tasks passed.

## Data and recovery

Repositories and runs belong to a workspace and all user endpoints check access.
A request UUID identifies a submission; retries reuse it instead of creating jobs.
Configuration is captured per run. Run state is persisted on the runner's disk and
synced into PostgreSQL. Logs retain the last 64,000 characters. On runner restart,
running attempts become blocked and their containers are removed; queued jobs survive.
Completed commands are never replayed. Cleanup failures keep capacity reserved and
prevent admission after restart until cleanup succeeds.

The UI shares a workspace SSE subscription with snapshots on reconnect and a
four-second fallback poll with backoff. Configure the callback below to save completed
results while no client is open. Callback delivery retries after outages and service
restarts. PostgreSQL only accepts results matching an existing run's configuration
and does not overwrite newer state with an older update.

## Runtime and isolation

`infra/repo-runner/server.mjs` is a trusted host controller. It creates a disposable
Docker container for each job: unprivileged UID, read-only root, dropped capabilities,
no Docker socket, bounded temporary memory and resource limits. Each job receives
one writable host mount: its own fixed-size ext4 workspace disk, without host
configuration or other tenant data. Only the trusted controller can mount it.
The runner key and internal API secret remain on the host. Child containers receive
neither. `network.sh` denies private, tailnet and metadata destinations.

gVisor mediates container system calls. Resource bounds, unprivileged users and
network filtering remain mandatory. The other host bind mount is the read-only
`/opt/qa-repo-runner/resolv.conf` containing public DNS servers (LF line endings),
needed because gVisor cannot use Docker's loopback DNS proxy. Run `runsc install` and reload Docker before
starting the service; missing runtime fails closed. Maintain host/runtime updates.
This is bounded shared capacity, not unlimited parallel execution.

## Configuration

App server environment (never public/client variables):

- `REPO_RUNNER_URL`: authenticated runner endpoint reachable by the app server.
- `REPO_RUNNER_KEY`: matching bearer key, at least 32 characters.

Runner `/opt/qa-repo-runner/service.env`, mode 0600:

- `REPO_RUNNER_KEY`: same key.
- `REPO_RUNNER_DATA`: optional, defaults to `/var/lib/qa-repo-runner`.
- `REPO_APP_URL` and `INTERNAL_API_SECRET`: terminal-result callback.
- `REPO_PUBLIC_URL`: public HTTPS base including `/repository`, required for previews.
- `EXECUTION_IMAGE`: optional runtime image, default `qa-repo-runner:public`.
- `PREVIEW_BROWSER_IMAGE`: optional preview image, default `qa-browser:execution`.

Install Docker, Node 24 at `/opt/qa-repo-runner/node`, copy runner files, build the
Dockerfile as `qa-repo-runner:public` (context `infra/repo-runner`), copy
`infra/execution` to `/opt/execution`, install the supplied systemd service and run
`systemctl enable --now qa-repo-runner`. Review the fixed bind IP in server.mjs for
the target host. Run `pnpm db:migrate` for the app's repository tables.

The runner binds to the VPS tailnet IP on port 8090. Local development reaches
it over Tailscale. Production uses the authenticated HTTPS `/repository` route
on the VPS Funnel endpoint, configured through the server environment variables.
Never configure Vercel with the private tailnet address directly.

Routine status and known commands use the main agent's repository tool directly;
the specialist remains available for investigation. Agent responses include at
most 2,000 log characters per run and 6,000 across a history response, with explicit
truncation notices. Full saved logs remain available in the workspace execution card. A truncated log
is not evidence about omitted checks.

## Verification

- `node --test tests/repo-runner.test.mjs`
- `node --test tests/repository-request.test.mjs`
- `node --test tests/repository-context.test.mjs`
- `pnpm lint`, `pnpm typecheck`, `pnpm build:agent`
- Explicit integration opt-in: set `RUN_REPOSITORY_TESTS=1`, then run
  `node --env-file=.env tests/repositories.integration.mjs` against local Nuxt.
  It creates and removes a temporary account/workspace, uses the real VPS runner,
  checks access, idempotency, queued cancellation and persisted terminal results.
- With the same opt-in, run `node --env-file=.env tests/repository-delegation.integration.mjs`
  for live model delegation, a real VPS job, specialist follow-up and cleanup.
  This uses model credits and can take several minutes.

## Execution card

Workspace shows active runs and the latest saved result across Overview, Testing
and Material. History exposes the last 30 runs. The card uses the shared execution feed,
shows the selected plan/runtime/directory, bounded logs, cancellation and an explicit
save-report-to-Material action.
It is a terminal view, not an interactive shell or a live Playwright desktop.
Results remain persisted automatically even if no material report is requested.
Npm projects without a lock use npm install and record that versions are resolved
at runtime. When local Playwright is installed, its own CLI downloads browsers;
OS dependencies are supplied by the runner image. Projects requiring extra services or custom setup
need explicit sandbox work rather than a guessed test script.

Install gVisor from its official apt repository, then run `runsc install` and
`systemctl reload docker`. Verify `docker run --rm --runtime=runsc
qa-repo-runner:public node --version` before deploying runner changes. Keep the
provided resolv.conf at `/opt/qa-repo-runner/resolv.conf`, readable and LF-encoded.
Repository workloads never run as root and never receive host credentials.
Material reports are generated server-side from the persisted run and use a
transactional receipt: retries return the same item; deleted reports must be
restored from the trash.

## Automatic script selection

New connections default to `auto`. After checkout the runner selects the first available script in this order: `test`, `test:unit`, `typecheck`, `lint`. It never automatically chooses dev, format, build or arbitrary scripts. Explicit script names are preserved and missing names report available alternatives. `selectedScript` records the actual command separately from the requested configuration; typecheck/lint outcomes explicitly describe static checks rather than functional coverage. Existing connections retain their script; reconnect with auto to change one.


## Eve sandbox and local preview

Eve is pinned to 0.47.3. `agent/lib/vps-sandbox.ts` implements its actual backend
contract through the authenticated internal app API. Commands, files and processes
run in gVisor on the VPS; the model stays in the app's Eve runtime. Each environment
has 1.5 GiB RAM, one CPU, an 8 GiB workspace disk, at most eight tracked concurrent
processes and a five-minute renewable lease. Stop retains files until expiry;
delete/expiry removes the disk. An expired environment is replaced with an explicitly
empty generation. Commands and files are never silently replayed or restored.

Eve's production prewarm uploads its seed files (including bundled skills) to the
authenticated worker `/templates` endpoint. Templates are immutable, bounded and
persist on the VPS; each environment receives them once without overwriting existing
files. Deploy the worker before the Eve build. Command-based bootstrap is unsupported;
reusable runtime tools belong in the worker image.
The adapter is pinned to Eve 0.47.3: worker template lookup preserves Eve's content
version while removing its host-local artifact-path scope, which differs between
Vercel build containers and workflow bundles. Different content never falls back
to another template version.

The code budget is 3 GiB (at most two code environments). The browser reserve is
another 3 GiB: two public sessions in a 2 GiB pool and one dedicated 1 GiB preview
container. This leaves host headroom on the current 8 GB VPS, but is not a claim
that arbitrary workloads fit CPU/disk requirements. Sandbox admission reports a
recoverable capacity error; repository jobs have a durable fair queue.

For an app, bind to `0.0.0.0`, verify its port locally, then call the agent's
`preview` tool. Its dedicated Chromium container can reach only the assigned
sandbox IP/port. Bridge firewall filtering must be enabled and IPv6 disabled.
Other private/tailnet/metadata destinations remain blocked. Viewer/control/CDP
credentials are distinct; human takeover blocks agent/CDP access. A visible app
preview renews its parent lease under either human or agent control, up to the
30-minute preview cap. Agent browser actions and captures renew it too. Hidden
tabs and minimized, idle previews do not renew it. Existing workspace disks keep
their original size until explicitly resized; the 8 GiB default applies to newly
created environments after deploying the worker update.

Both the coordinator and repository specialist use `inspect_environment` before
cloning, installing, retrying setup or starting a service. This read-only tool
inspects the caller's sandbox for repository origins/revisions/local changes,
Node manifests, dependency folders, active processes, listening ports and free
disk. Results are bounded and indicate incomplete scans. A dependency folder is
not proof that installation succeeded; an open port is not an HTTP health check.
Instructions require reuse of matching state, checks before retry and no parallel
installs into one directory. Shell commands remain general-purpose, so this is
agent guidance with observed state, not a shell-level guarantee against duplicates.
Parent stop/expiry revokes the firewall rule before removing the browser. An
independent public browser is unaffected. No arbitrary port-forward or host shell
is exposed. A shell that starts an app with nohup may finish while its background
app remains alive; the process card reports the shell's actual exit.

## Delivery and rollout

State and event snapshots are atomically replaced with increasing revisions and
sequence numbers. Clients ignore older events. The journal retains 128 metadata
entries plus the latest snapshot and bounded log tails; reconnect sends this
snapshot, not full historical output. Origin-bound subscription grants last two
minutes and contain only IDs authorized by the app, never service keys. The
callback outbox persists ACK/rejection/backoff receipts. Deleted runs do not starve
healthy deliveries.

New plans are delivered only when `/api/internal/execution-capabilities` reports
protocol 1 under internal authentication. VPS services are already updated;
new callbacks to production wait until the app is deployed. The additive browser
assignment migration is applied. Results persist without a model call. Automatic
Eve wake-up on independent job completion is not wired yet; the agent reads saved
results on the next request.

## Operations and recovery

Repository `start` accepts an optional `script` override for that run; omitting it
uses the saved connection default. Retrying a request ID with a different script
is a conflict. Bounded checks/builds never mean an app is running: their checkouts
are removed on completion. Use the Eve sandbox for `dev`/`start`/`serve`, verify
HTTP and attach `preview`. Preflight reports legacy `next lint` with a declared
Next.js 16+ version as a configuration issue before installing dependencies; it
does not silently substitute a build or modify the third-party repository.

Before deployment, inspect authenticated health on both services and active sandbox
sessions. Set `/drain` on the repository worker and wait for jobs and leases to end;
do not interrupt user browsers. Restart preserves queued work and stopped sandbox
disks within their lease, and marks running attempts interrupted. Failed cleanup
keeps admission closed. Health validates Docker, runsc registration, image/network
existence and the 8 GiB free-disk reserve. Real smoke tests verify actual execution.

Deploy source under `/opt/qa-repo-runner` and `/opt/execution`, then restart
`qa-repo-runner`; browser deployment is documented in SELF_HOSTED_BROWSER.md.
Back up persistent JSON metadata and delivery receipts before upgrades, along with
source/images. Do not copy mounted disks as if they were consistent snapshots or
restore running jobs as queued commands. Rollback keeps additive database tables
and existing run IDs. Do not downgrade to a worker that ignores the isolation
runtime or the shared capacity budget.

This rollout retained source backups at `/opt/qa-execution-backup-20260930` and
images `qa-browser:before-execution` / `qa-repo-runner:before-execution`.
Automatic fleet dispatch, record expiry, off-host backup rotation, per-workspace
sandbox fairness and full mixed-load benchmarks remain follow-up work. Bounded
log tails limit each record, but the number of stored records still grows.

Additional opt-in integration check (consumes VPS resources):

```powershell
$env:RUN_EXECUTION_TESTS='1'
node --env-file=.env tests/execution.integration.mjs
```

On an idle VPS, `infra/repo-runner/sandbox-smoke.mjs` verifies runtime, files,
ownership and lifecycle. `runtime-smoke.mjs` runs Maven/JUnit, Gradle/JUnit, Python
and deliberately failing Node fixtures. Set `RUNTIME_SMOKE_ONLY=gradle` for the
Gradle fixture alone. Use the worker modules and their fixed filesystem paths.
The app integration creates and removes a disposable user and covers preview,
two browsers, isolation, takeover, teardown, SSE origin and reconnect behavior.

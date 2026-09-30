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

- Node 24, npm (lockfile preferred), or pnpm@10.33.4 with pnpm-lock.yaml.
- package.json must be in the repository root. Monorepo root scripts work.
- Public GitHub repositories; no per-repo allowlist or GitHub grant required.
- Every job requires the gVisor `runsc` runtime; no fallback to plain runc.
- Installation lifecycle scripts are disabled. Explicit selected scripts execute.
- Optional script arguments select a bounded test subset; arguments are forwarded as argv, never host shell code.
- Test scripts run under Xvfb so headed browser tests have a virtual display.
- One running job, up to 20 pending jobs, ten-minute timeout, 3 GiB RAM and one CPU.
- Private repositories, application previews and automatic test-case import are not implemented.

A successful command is not proof of functional coverage. Store the selected
script, exact commit, exit code and output; keep repository results separate from
manual/browser test-case results. `surdeg` has no root test script. Its `typecheck`
was verified on commit 618c2e7bf4fcfb3f22b170643bc5205b26922977: two tasks passed.

## Data and recovery

Repositories and runs belong to a workspace and all user endpoints check access.
A request UUID identifies a submission; retries reuse it instead of creating jobs.
Configuration is captured per run. Run state is persisted on the runner's disk and
synced into PostgreSQL. Logs retain the last 64,000 characters. On runner restart,
unfinished jobs become blocked and their containers are removed.

The UI polls active runs. Configure the optional callback below to save completed
results while no client is open. Callback delivery retries after outages and service
restarts. PostgreSQL only accepts results matching an existing run's configuration
and does not overwrite newer state with an older update.

## Runtime and isolation

`infra/repo-runner/server.mjs` is a trusted host controller. It creates a disposable
Docker container for each job: unprivileged UID, read-only root, dropped capabilities,
no Docker socket or writable host mounts, bounded writable tmpfs and resource limits.
The runner key and internal API secret remain on the host. Child containers receive
neither. `network.sh` denies private, tailnet and metadata destinations.

gVisor mediates container system calls. Resource bounds, unprivileged users and
network filtering remain mandatory. The only host bind mount is the read-only
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
- `REPO_APP_URL` and `INTERNAL_API_SECRET`: optional terminal-result callback.

Install Docker, Node 24 at `/opt/qa-repo-runner/node`, copy runner files, build the
Dockerfile as `qa-repo-runner:public`, install the supplied systemd service and run
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
and Material. History exposes the last 30 runs. The card polls every four seconds,
shows bounded text logs, cancellation and an explicit save-report-to-Material action.
It is a terminal view, not an interactive shell or a live Playwright desktop.
Results remain persisted automatically even if no material report is requested.
Npm projects without a lock use npm install and record that versions are resolved
at runtime. When local Playwright is installed, its own CLI downloads browsers;
OS dependencies are supplied by the runner image. Other languages, custom setup
steps and arbitrary application previews are not automatically supported.

Install gVisor from its official apt repository, then run `runsc install` and
`systemctl reload docker`. Verify `docker run --rm --runtime=runsc
qa-repo-runner:public node --version` before deploying runner changes. Keep the
provided resolv.conf at `/opt/qa-repo-runner/resolv.conf`, readable and LF-encoded.
Repository workloads never run as root and never receive host credentials.
Material reports are generated server-side from the persisted run and use a
transactional receipt: retries return the same item; deleted reports must be
restored from the trash.

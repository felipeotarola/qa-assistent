# Repository testing pilot

Testing accepts a public GitHub URL, branch/tag and package script. The Eve repo
specialist can inspect the repository and submit the same jobs as the UI. Jobs
run asynchronously; the UI and activity panel display saved progress and logs.
Live delegation is verified through the Eve client: the parent calls `repo`, the
child starts a VPS run with inherited workspace identity, and a follow-up resumes
that specialist to report the saved successful result without a duplicate job.
Agent submission IDs are derived from the thread and Eve tool call ID, rather
than model-generated UUIDs. Replay of the same call remains idempotent.

## Supported scope

- Node 24, npm with package-lock.json, or pnpm@10.33.4 with pnpm-lock.yaml.
- package.json must be in the repository root. Monorepo root scripts work.
- Administrator-approved public repositories only (`REPO_ALLOWED_REPOS`).
- Installation lifecycle scripts are disabled. Explicit selected scripts execute.
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
no Docker socket or host bind mounts, bounded writable tmpfs and resource limits.
The runner key and internal API secret remain on the host. Child containers receive
neither. `network.sh` denies private, tailnet and metadata destinations.

Docker shares the host kernel. This pilot is for trusted, allowlisted repositories;
it is not a hostile multitenant code-execution service. Broader customer execution
needs stronger isolation and capacity management before removing the allowlist.

## Configuration

App server environment (never public/client variables):

- `REPO_RUNNER_URL`: authenticated runner endpoint reachable by the app server.
- `REPO_RUNNER_KEY`: matching bearer key, at least 32 characters.

Runner `/opt/qa-repo-runner/service.env`, mode 0600:

- `REPO_RUNNER_KEY`: same key.
- `REPO_ALLOWED_REPOS`: comma-separated canonical GitHub URLs.
- `REPO_RUNNER_DATA`: optional, defaults to `/var/lib/qa-repo-runner`.
- `REPO_APP_URL` and `INTERNAL_API_SECRET`: optional terminal-result callback.

Install Docker, Node 24 at `/opt/qa-repo-runner/node`, copy runner files, build the
Dockerfile as `qa-repo-runner:node24`, install the supplied systemd service and run
`systemctl enable --now qa-repo-runner`. Review the fixed bind IP in server.mjs for
the target host. Run `pnpm db:migrate` for the app's repository tables.

Current pilot binds to the VPS tailnet IP on port 8090. Local development can reach
it over Tailscale. Vercel cannot use this private address directly: production needs
a reachable authenticated HTTPS endpoint, production environment configuration and
an app deployment. This feature has not yet been released to production.

## Verification

- `node --test tests/repo-runner.test.mjs`
- `node --test tests/repository-request.test.mjs`
- `pnpm lint`, `pnpm typecheck`, `pnpm build:agent`
- Explicit integration opt-in: set `RUN_REPOSITORY_TESTS=1`, then run
  `node --env-file=.env tests/repositories.integration.mjs` against local Nuxt.
  It creates and removes a temporary account/workspace, uses the real VPS runner,
  checks access, idempotency, queued cancellation and persisted terminal results.
- With the same opt-in, run `node --env-file=.env tests/repository-delegation.integration.mjs`
  for live model delegation, a real VPS job, specialist follow-up and cleanup.
  This uses model credits and can take several minutes.

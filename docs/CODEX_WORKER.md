# Otto VPS worker

Eve can delegate repository setup or diagnosis through the `codex` tool. This
is an optional worker with shared capacity and isolated user environments. The existing repository runner, Eve sandbox,
browser sessions and preview remain available. No OpenAI API-key fallback.

## Execution boundary

The trusted runner starts pinned Codex CLI 0.159.3 app-server as the dedicated
unprivileged `qa-codex` user. Its HOME contains only its own ChatGPT login and
control state. It receives no application, runner or API keys. Thread environment
access is explicitly empty; built-in shell, apps, browser, computer use and
multi-agent tools are disabled. Unknown server requests are rejected. The
experimental dynamic-tool protocol is pinned and covered by a real smoke test.

Codex receives scoped `inspect_environment`, `execute`, `process`, and
`stop_process` tools. Their implementation runs in the trusted parent and calls
the existing gVisor sandbox. Repository code never runs as `qa-codex`, never
receives its login, and cannot select another sandbox or process. Inspection
must finish successfully before mutation. Eve's independent shell writes are
blocked while Codex owns the environment.

One Codex task at a time, a 20-minute task limit, idempotent submissions and
authenticated account/workspace checks apply. The controller renews the sandbox
lease while working. Stopping the environment interrupts Codex within 20 seconds.
Failure/cancellation stops processes started by the task; successful app servers
remain available for Eve's existing `preview(port)` tool. Worker restarts do not
replay tasks or processes. The VPS card shows progress, logs and the final report.

Codex completion means the agent finished reporting, not that tests passed.
The report must distinguish installation, static checks, HTTP readiness and tests.
Registered setup jobs send their result back to the parent chat. Eve can also
read `codex(action: status, jobId)` and the UI continues updating. Submission or
worker completion alone does not establish application readiness.

## Access and shared capacity

Set `CODEX_ACCESS_MODE` in **both the runner and app/Eve environment**:

| Mode | New tasks and configuration |
|------|-----------------------------|
| `shared` | All authenticated app accounts with access to their own thread/workspace |
| `pilot` | Only the UUID in `CODEX_PILOT_USER_ID` |
| `disabled` | No new work |

An omitted mode preserves a valid legacy pilot UUID; without one it is disabled.
Unknown modes fail closed. `shared` explicitly overrides the legacy pilot UUID.
The runner enforces admissions. Agent instructions re-evaluate access each turn.
After admissions are disabled, owners may still inspect or cancel their own jobs.

The service shares the VPS and its configured model subscription capacity, never
the model login, sandbox files, processes, reports or Vault values. Authentication,
thread ownership and sandbox/job ownership checks remain mandatory. A second
concurrent request receives a busy response without another user's job details;
it is **not queued**. One active Otto job globally remains the limit. Shared access
does not remove the guard against starting new shell tasks in a sandbox containing
injected credentials.

## Provision and authenticate

1. Run `infra/codex-worker/install.sh` on the VPS as root. It verifies the pinned
   npm distribution's SHA-512 integrity before extracting it.
2. Run `runuser -u qa-codex -- /opt/qa-codex/codex login --device-auth` and complete
   the requested sign-in yourself. Never copy auth.json into an application repo,
   container, Material, or logs. This consumes the signed-in subscription limits.
3. Deploy `infra/codex-worker/*.mjs` to `/opt/codex-worker/`, the shared inspection
   module to `/opt/execution/environment-inspection.mjs`, and the updated runner.
4. Set `CODEX_ACCESS_MODE=shared` in the private runner `service.env` and app/Eve
   environment to enable all authenticated app users. For restricted rollout,
   use `pilot` with `CODEX_PILOT_USER_ID`. The caller identity comes from Eve
   authentication and is validated against the app's thread record; it is not
   a model argument. Model login credentials remain private to the service user.
5. Restart the runner when no user environment is active. Deploy the Nuxt/Eve
   changes separately. The existing browser service needs no changes.

## Verification

`node /opt/codex-worker/smoke.mjs` checks subscription authentication and a dynamic
tool round trip. It uses a small model turn.

`QAA_RUNNER_MODULE=file:///opt/qa-repo-runner/sandbox.mjs node
/opt/codex-worker/integration.mjs` runs a real Codex task in a temporary gVisor
environment, starts a tiny HTTP app, independently verifies its response and
absence of controller credentials, checks events, and removes its own resources.
Use `/opt/qa-repo-runner/node` where Node is not on the host PATH.

`pnpm test:unit` checks shared/pilot/disabled access, two-user sandbox and Vault
isolation, cross-user denials, global capacity, replay, inspection gating,
cancellation and recovery without model calls. Re-run live protocol verification
before any CLI upgrade. Do not assume future experimental protocol compatibility.

Official references: [app-server](https://developers.openai.com/codex/app-server),
[authentication](https://developers.openai.com/codex/auth).

## Chat handoff

An active Codex tool result sets a durable per-turn handoff flag. The next
model step is text-only (no tools), ending Vera's turn instead of polling.
The turn.started hook resets the flag for each new user turn, including in
the repository subagent. VPS progress continues independently in the card.
Run the opt-in tests/codex-chat-handoff.integration.mjs with
RUN_CODEX_CHAT_TESTS=1 to verify handoff, chatting during execution, and a
fresh status request against the running local app.


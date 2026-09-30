# VPS browser pilot

The existing `browser` agent tool and Workspace browser card can use the VPS
instead of Browserbase. The deployed public pool supports **two concurrent sessions** within 2 GiB.
A separate 1 GiB slot is reserved for a dedicated local app-preview browser.
`run.sh` fixes the public limit as part of the shared resource budget. Every session has
its own Chromium process, temporary profile, dynamically allocated loopback CDP
port and separate viewer/CDP credentials. Chromium runs as a non-root user with
its sandbox enabled. The processes share a resource-limited container; this is
not VM or container isolation per session. Capacity includes starting and closing
sessions; excess requests receive HTTP 409 without interrupting existing work.

## Local configuration

Set these server-only variables in `.env` and restart `pnpm dev`:

```dotenv
BROWSER_PROVIDER=vps
BROWSER_SERVICE_URL=http://100.122.229.15:8080
BROWSER_SERVICE_KEY=<random secret shared with the VPS>
```

The private HTTP address requires Tailscale. The service also has a public
HTTPS endpoint through Tailscale Funnel for production:
`https://qaa-vps-1.tail22aa3b.ts.net`. Production uses this address for
`BROWSER_SERVICE_URL`, and the VPS uses it for `BROWSER_PUBLIC_URL`, so live
view and CDP connections use WSS. The iframe permits localhost:3000 and
`https://qa-assistent.vercel.app`.

Funnel is configured with
`tailscale funnel --bg --yes http://100.122.229.15:8080`.
The API still requires the shared service key; session sockets require their
own tokens. Do not expose port 9222 or the Docker socket publicly.
Leaving `BROWSER_PROVIDER` unset retains Browserbase. With `BROWSER_PROVIDER=vps`, both live browsing and research use the VPS.
Research releases its temporary session after capture and shares public capacity.
There is no silent Browserbase fallback.

## Deployment

Source lives in `infra/browser`. The deployed copy is `/opt/qa-browser` on
`root@100.122.229.15`. Docker and systemd run the service. `service.env` (0600)
contains `BROWSER_SERVICE_KEY` and `BROWSER_PUBLIC_URL`; never commit it.

Build from the **infra root** with
`docker build -f browser/Dockerfile -t qa-browser:execution .` so common execution
modules are included. Tag the verified image as `qa-browser:pilot` for the public
service. Copy the official Playwright
v1.63.0 `utils/docker/seccomp_profile.json` to `/opt/qa-browser/seccomp.json`,
install `qa-browser.service` in `/etc/systemd/system`, then run
`systemctl enable --now qa-browser`. `run.sh` restricts the published port to
Tailscale, sets CPU/RAM/process limits and installs private-network egress rules.
Service restarts close active sessions; deploy only when unused. `run.sh` loads
br_netfilter and enables bridge firewall filtering. It sets the persistent state
directory owner from the image's actual UID/GID instead of assuming UID 1000.
Restricted event state is stored under `/var/lib/qa-browser`.

Useful checks: `systemctl status qa-browser`, `docker logs qa-browser`.
`GET /health` requires the bearer service key. Logs omit viewer tokens,
screenshots and typed values. Do not enable protocol debug logging in normal use.

## Session behavior

- Browsers are assigned per workspace, chat and agent. Migration 0014 adds explicit
  assignments; the first main assignment adopts the old workspace session once.
  The workspace selector supports multiple sessions. Controls/resume carry a
  session ID and the server validates workspace access.
- Agent navigation uses the existing authenticated internal API and CDP.
- One capture loop per session distributes JPEG frames to viewers, with hidden-viewer throttling; this is not video recording.
- **Ta över** enables server-validated mouse clicks, scrolling, text/paste and basic keyboard input.
- **Lämna tillbaka** disables manual input and resumes the existing agent flow.
- Closing destroys Chromium and its temporary profile. Each new session starts logged out.
- App idle expiry is ten minutes; the VPS also enforces a thirty-minute lifetime.
- Run screenshots still use the existing private Blob evidence pipeline with password masking.
- Read-only viewer, rotating human-control and CDP tokens have distinct scopes.
  Stale queued inputs are rejected by control epoch; CDP is blocked during takeover.
  Compatibility mode remains for old clients; the new app requests scoped tokens.
- Existing DB `projectId = self-hosted-v1` identifies VPS sessions for cleanup;
  Browserbase context IDs remain intact for a future switch back.

This first viewer does not support file upload dialogs, drag gestures, audio,
downloads or a tab-selection toolbar. Public web pages are supported; access to
private networks is blocked. Local app preview uses a dedicated browser
container with an exact sandbox IP/port rule, a 30-minute cap and teardown coupled
to the parent environment. Its authenticated gateway is under `/repository/preview`.
See [sandbox operations](REPOSITORY_TESTING.md).

## Verification

Inside the container, `node /app/smoke.mjs` (copy the test there first) tests
concurrent creation, auth, capacity, profile/token isolation, independent closure, live frames, manual input, agent resume, screenshots,
closure and a fresh profile. It requires no active user session.

From the repo with the local app running:

```powershell
$env:RUN_VPS_BROWSER_TESTS='1'
node --env-file=.env tests/browser.integration.mjs
$env:RUN_WORKSPACE_TESTS='1'
$env:TEST_CAPTURES='1'
node --env-file=.env tests/test-runs.integration.mjs
```

These use temporary users and remove their own fixtures. The browser test also
polls the workspace during first-session creation to detect DB pool deadlocks.
Set `APP_URL=https://qa-assistent.vercel.app` and use matching production
credentials to verify production instead. Never commit those credentials.

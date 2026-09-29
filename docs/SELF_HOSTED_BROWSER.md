# VPS browser pilot

The existing `browser` agent tool and Workspace browser card can use the VPS
instead of Browserbase. This pilot supports **one active session across all
workspaces**. Chromium runs as a non-root user with its sandbox enabled.

## Local configuration

Set these server-only variables in `.env` and restart `pnpm dev`:

```dotenv
BROWSER_PROVIDER=vps
BROWSER_SERVICE_URL=http://100.122.229.15:8080
BROWSER_SERVICE_KEY=<random secret shared with the VPS>
```

Both the local app server and the user's browser must be on the Tailscale
network. The iframe allows localhost:3000 only. This is **not yet a Vercel
production connection**: that requires authenticated HTTPS access from the
deployed server and a configured frame origin. Do not expose port 9222 or the
Docker socket publicly. Leaving `BROWSER_PROVIDER` unset retains Browserbase.

## Deployment

Source lives in `infra/browser`. The deployed copy is `/opt/qa-browser` on
`root@100.122.229.15`. Docker and systemd run the service. `service.env` (0600)
contains `BROWSER_SERVICE_KEY` and `BROWSER_PUBLIC_URL`; never commit it.

Build `qa-browser:pilot` from the Dockerfile, copy the official Playwright
v1.63.0 `utils/docker/seccomp_profile.json` to `/opt/qa-browser/seccomp.json`,
install `qa-browser.service` in `/etc/systemd/system`, then run
`systemctl enable --now qa-browser`. `run.sh` restricts the published port to
Tailscale, sets CPU/RAM/process limits and installs private-network egress rules.
Service restarts close any active session; deploy only when it is unused.

Useful checks: `systemctl status qa-browser`, `docker logs qa-browser`.
`GET /health` requires the bearer service key. Logs omit viewer tokens,
screenshots and typed values. Do not enable protocol debug logging in normal use.

## Session behavior

- Agent navigation uses the existing authenticated internal API and CDP.
- The iframe receives JPEG live frames, roughly four per second; it is not video recording.
- **Ta över** enables server-validated mouse clicks, scrolling, text/paste and basic keyboard input.
- **Lämna tillbaka** disables manual input and resumes the existing agent flow.
- Closing destroys Chromium and its temporary profile. Each new session starts logged out.
- App idle expiry is ten minutes; the VPS also enforces a thirty-minute lifetime.
- Run screenshots still use the existing private Blob evidence pipeline with password masking.
- Viewer credentials are separate from CDP credentials and cannot create sessions.
- Existing DB `projectId = self-hosted-v1` identifies VPS sessions for cleanup;
  Browserbase context IDs remain intact for a future switch back.

This first viewer does not support file upload dialogs, drag gestures, audio,
downloads or a tab-selection toolbar. Public web pages are supported; access to
private networks is blocked. Future local/backend test runners need a separate,
explicitly scoped network policy, not unrestricted browser access to the VPS.

## Verification

Inside the container, `node /app/smoke.mjs` (copy the test there first) tests
creation, auth, capacity, live frames, manual input, agent resume, screenshots,
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

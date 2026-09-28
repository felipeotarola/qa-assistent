# Live browser

The web agent opens a Browserbase Chromium session in the right-hand Workspace
panel using its `browser` tool. `BROWSERBASE_API_KEY` is server-only.
`BROWSERBASE_PROJECT_ID` is optional when the key has exactly one project.
Browserbase must support keep-alive sessions and have available browser minutes.

## User flow

Ask the agent to visit a website. The live view opens automatically in that chat.
Use **Ta över** to take control and sign in directly in the remote browser.
After any in-flight action finishes, the server blocks further agent actions,
including reading the page. **Lämna tillbaka** gives control back and sends a
continuation to the chat; the agent reads the current page before continuing.
The close button releases Chromium while retaining its Browserbase Context for
later visits. Website session expiry and MFA may still require another login.

The browser currently belongs to one user and one chat. It is not shared across
chats; a future workspace entity can become its scope. There is one active
Browserbase session per chat, potentially with multiple browser tabs.

## Implementation

- `agent/tools/browser.ts`: typed actions; obtains identity and chat scope from
  authenticated Eve context, never from model arguments.
- `server/api/internal/browser.post.ts`: authenticates the Eve internal request
  and verifies the chat belongs to the supplied principal.
- `server/utils/browser.ts`: Browserbase, Playwright CDP, fresh element refs,
  session lifecycle, and PostgreSQL advisory locks for serialized actions.
- `app/components/BrowserWorkspace.vue`: interactive live view and control UI.
- `pat_browser_sessions`: RLS-enabled server-owned state in Supabase. Connection
  and live-view URLs are sensitive capabilities. The connection URL never goes
  to the frontend or model; only the authenticated owner receives the live URL.

Recordings and Browserbase session logging are disabled for these sessions.
Manually entered passwords are not sent through chat or the model. Page text
read after returning control is sent to the selected model as tool output.

Sessions close after ten minutes without tool activity. While the human has
focused the live iframe in a visible app tab, a heartbeat renews the idle lease.
Every session also has a provider-enforced thirty-minute maximum. Local Nitro
cleans idle sessions every minute; polling also enforces expiry. On a serverless
host without a continuously running process, the provider maximum remains the
backstop. Deleting a chat releases its session and removes its saved Context.

This is browser interaction, not generated Playwright test files. The initial
tool supports page reading, navigation, click, fill, press, select, and scrolling.
Controls inside nested frames or complex custom widgets may need manual takeover.
Browserbase runs remotely: your computer's localhost is not its localhost.

## Verification

Run `pnpm typecheck`, `pnpm lint`, and `pnpm build:agent`.
The opt-in `tests/browser.integration.mjs` creates a temporary Supabase account
and real Browserbase sessions, verifies ownership/control/navigation/cleanup,
and deletes its fixtures. Set `RUN_BROWSERBASE_TESTS=1`; optionally set
`TEST_EVE_BROWSER=1` to test a complete GLM + Eve tool call. Run it with
`pnpm exec node --env-file=.env tests/browser.integration.mjs` while dev is running.
It uses browser minutes and, with Eve enabled, model tokens.

Nuxt type generation/build commands can replace generated files used by a live
dev process. If Vite reports an unresolved `#app-manifest` after running those
commands, restart `pnpm dev` and reload the browser.

# Environment Variables

> Back to [README](../README.md) | See also: [Architecture](./ARCHITECTURE.md), [Customization](./CUSTOMIZATION.md)

Copy the example file and fill in the values:

```bash
cp .env.example .env
```

## Quick start (minimum required)

| Variable | How to get it |
|----------|---------------|
| `SUPABASE_URL` | Supabase project URL (NEXT_PUBLIC_SUPABASE_URL also accepted) |
| `SUPABASE_PUBLISHABLE_KEY` | Public project key (NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY also accepted) |
| `DATABASE_URL` | Supabase PostgreSQL connection string |
| `APP_URL` | `http://localhost:3000` locally, or your production URL |
| `INTERNAL_API_SECRET` | Run `openssl rand -base64 32` (must match on web + eve services) |

On Vercel, set them on **both** the `web` and `eve` services — and add a database (see below).

## Self-hosted browser (optional)

`BROWSER_PROVIDER=vps`, `BROWSER_SERVICE_URL` and `BROWSER_SERVICE_KEY` select
the private VPS browser. Keep these server-only. See
[VPS browser setup and limitations](./SELF_HOSTED_BROWSER.md).
Without this selector, the existing Browserbase configuration remains in use.

## Database

### `DATABASE_URL` (required everywhere)

NuxtHub uses PostgreSQL with the postgres-js driver in development and production.
Set DATABASE_URL to your Supabase PostgreSQL connection string (API keys alone
are not sufficient). The existing database can be shared: application tables,
indexes and the migration ledger use the pat_ prefix. Existing unprefixed tables
are left untouched. RLS is enabled; these tables are accessed by the trusted
server database connection, not directly through the Supabase public API.

pnpm db:migrate uses Drizzle with public.pat_migrations. Both pnpm dev and
pnpm build run it automatically. NuxtHub's default migration runner is disabled
to avoid creating an unprefixed migration ledger in the shared database.
The initial migration targets a fresh pat_ installation; an existing installation
using unprefixed tables needs a separate data migration before switching.

The project declares Node 24 in package.json (devEngines.runtime). Run pnpm install
once; pnpm downloads the compatible runtime and uses it for pnpm dev and other
project scripts, even when the system-wide Node is older.

Provision [Neon from the Vercel Marketplace](https://vercel.com/marketplace/neon) — the
Deploy button in the README includes it — or add it to an existing project:

```bash
vercel integration add neon
```

The integration sets `DATABASE_URL` on Production and Preview. Add it to
**Development** as well (a separate Neon branch keeps local work off the
deployed data), then pull it locally:

```bash
vercel env pull
```

Migrations in [`server/db/migrations/postgresql/`](../server/db/migrations/postgresql/)
are applied at build time, and on `pnpm dev`. To apply them by hand:

```bash
pnpm db:migrate
```

The driver is pinned in [`nuxt.config.ts`](../nuxt.config.ts) rather than
auto-detected. Left to itself, NuxtHub falls back to `pglite` when no URL is
set, and pglite's WebAssembly payload does not survive the bundling eve does to
run the agent — the failure surfaces much later as a missing `pglite.data`.

### `NUXT_PUBLIC_SITE_URL` (optional)

Canonical URL for SEO — used for Open Graph images, Twitter cards, and canonical links. Set to your production URL (e.g. `https://your-app.vercel.app`). Falls back to the request origin when unset.

## Authentication

Supabase Auth is the identity provider. Existing users in this Supabase project's
Authentication users list can sign in with their email and password. Database
credentials, Supabase dashboard credentials, and accounts in unrelated public
tables are not Auth accounts.

Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY on both web and Eve. The existing
NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY names are also
accepted. Only the publishable key is exposed to the browser; no service-role key
is needed. Cookies are scoped with the pat_supabase_auth name.

For sign-up confirmation, allow http://localhost:3000/auth/callback (and the
production equivalent) in Supabase Auth URL Configuration. Confirmation requires
the same browser that initiated sign-up for the PKCE exchange; users can sign in
normally after confirming elsewhere. The app displays a confirmation notice when
Supabase requires email verification.

APP_URL is the Nuxt origin for Eve's internal API calls. It defaults to
http://localhost:3000 locally. BETTER_AUTH_URL is accepted as a legacy fallback;
BETTER_AUTH_SECRET is no longer used.

Supabase UUIDs are mirrored to pat_user on authenticated requests. Legacy Better
Auth accounts are not automatically merged by email, and their data is retained.

## Internal API

### `INTERNAL_API_SECRET` (required)

Shared bearer token between the Eve agent service and the Nuxt internal API (`/api/internal/*`).

Used for:

- Caller identity for the agent's session instructions
- Slack account linking
- Phone linking lookup

**Must be identical** on both Vercel services (`web` and `eve`). If missing or mismatched, Slack and phone linking will fail silently or return 401.

## Vercel Blob (memory)

Eve's `fileMemory()` provider stores one private Blob document per user at
`eve/memory/file/<scope>/MEMORY.md`. Configure `WORKSPACE_BLOB_READ_WRITE_TOKEN`
for the same private Blob store locally and in production. The memory provider
explicitly uses this token; a public Blob store cannot serve private memory.

## AI provider — Grunden

Set GRUNDEN_API_TOKEN on the Eve service (and in the local .env). The agent
calls https://api.grunden.ai/v1/chat/completions through the OpenAI-compatible
AI SDK provider. No Vercel AI Gateway key is needed for these models.

The chat composer offers GLM 5.3 (glm-5.3, default) and Flash
(glm-5.3-flash). The browser remembers the preference in pat_chat_model and
sends the allowlisted choice with each Eve request. Eve carries it in the
authenticated turn's attributes and resolves the provider at each model step.
Changing models applies to the next message in the same conversation.
Non-web channels default to GLM 5.3. Both models advertise a usable context
of 190,000 tokens in Grunden's model registry.

GRUNDEN_HMAC_KEY is for verifying asynchronous webhook deliveries; the
interactive chat uses streaming responses and does not need this key.
Neither credential is exposed in the browser runtime config or request headers.
The openai-compatible provider version is pinned to match the AI SDK/Eve
provider types; upgrade these packages together.

## Vercel Connect (optional)

Integrations use [Vercel Connect](https://vercel.com/docs/connect) — no extra env vars in this repo for Linear or GitHub OAuth, but you must:

1. Create Connect resources (GitHub, Linear MCP, Slack) in your Vercel team
2. Update connector UIDs in [`shared/connect.ts`](../shared/connect.ts) (GitHub) or [`agent/channels/slack.ts`](../agent/channels/slack.ts) (Slack, default: `slack/personal-agent-template`)
3. Connect clients in **Settings → Integrations** in the app

See [Customization](./CUSTOMIZATION.md#integrations) for setup steps.

## GitHub (optional)

GitHub tools use per-user OAuth via Vercel Connect. Connect in **Settings → Integrations**, then start a new chat session so GitHub tools load at `session.started`.

## Local-only files

These paths are gitignored and should never be committed:

| Path | Purpose |
|------|---------|
| `.env` | Local secrets |
| `.data/` | NuxtHub local state |
| `.eve/` | Eve dev cache |
| `.vercel/` | Vercel CLI link metadata |

For a clean development database, use a separate Supabase project or Neon branch.
Do not reset the public schema of a shared database.

## Repository test environment vault

`ENV_VAULT_KEY` is the server-only encryption key (at least 32 characters). If
unset, the application uses `OAUTH_ENCRYPTION_KEY`, then `BETTER_AUTH_SECRET`, with
a separate HKDF context. Keep the selected key stable across all app runtimes that
share this database; changing it without re-encrypting entries makes them unreadable.
Never expose this key through Nuxt public config. Migration `0017` creates the
RLS-enabled job and vault tables. Values are AES-256-GCM encrypted with the exact
workspace/repository/test scope authenticated as additional data.

Deploy the application **and** the updated `infra/repo-runner` / `infra/codex-worker`
code before testing the complete flow. The VPS needs `REPO_APP_URL` pointing to the
deployed app and the matching `INTERNAL_API_SECRET`. Terminal setup results use
`/api/internal/setup-result`; the application queues the original Eve session at
`/workers/setup/notify`. The local workspace also reconciles status while open.
Local and production Eve sessions are distinct; a local closed tab cannot rely on
a production callback to wake its local session.

The VPS keeps encrypted redaction material under
`REPO_RUNNER_DATA/environment-redaction`, encrypted using `REPO_RUNNER_KEY`. Keep
this directory private and backed up with the worker data. Old values remain in
the redaction set after rotation so historical output remains masked; encrypted
redaction entries currently follow the runner data retention policy. Rotating the
runner key requires migrating or retiring these entries first.

Project values are separate from the app's own environment. Users enter only the
requested variables in **Pågående arbete → Konfigurera testmiljön** or import a
simple single-line `.env` file locally. Save-only does not execute anything.
Save-and-continue explicitly grants those values to the displayed repository at
the verified commit. The worker injects them into the restarted process over stdin;
it does not write a `.env` into the checkout. Shell interpolation during import is
disabled. Values are never returned by the settings API or sent in agent prompts.

Repository code receives the granted values and can use them, including over its
network. Use scoped test credentials. Once configured, new agent shell/file calls
in that sandbox are blocked to prevent reading process environments. Preview,
redacted process status, configuration and stop remain available. New code work
needs a separate sandbox. Removing a saved value does not revoke it from an already
running process; restart or stop the process and revoke the credential at its
provider if needed.

The Reasoning selector offers low, high and max for both Grunden models. Max is
the default, matching the provider. The pat_chat_reasoning cookie remembers the
selection; x-pat-reasoning carries it into the authenticated turn and the provider
sends it as reasoning_effort. Invalid values fall back to max. Both selectors
are disabled while a reply is in progress and changes apply to the next message.

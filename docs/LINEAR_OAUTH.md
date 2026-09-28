# Direct Linear OAuth

Linear uses our own OAuth app; GitHub continues using Vercel Connect.

Set LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET and LINEAR_REDIRECT_URI on the server.
Register http://localhost:3000/api/integrations/linear/callback in Linear for local development.
For production register https://qa-assistent.vercel.app/api/integrations/linear/callback
and use that as LINEAR_REDIRECT_URI in Vercel. Do not use localhost in production.

Credentials are encrypted with AES-256-GCM, bound to the app user ID and stored
in pat_linear_accounts (RLS, server access only). OAUTH_ENCRYPTION_KEY is the
preferred stable encryption secret; if omitted, BETTER_AUTH_SECRET is used with
a domain-separated derived key. The same secret must be configured locally and
in production to share grants. Do not rotate it without migrating encrypted rows.

pat_linear_oauth_states stores hashed, single-use, ten-minute states and encrypted
PKCE verifiers. Callback validation requires the initiating browser cookie and
the same signed-in user. Denial preserves an existing grant. Reconnection replaces
that user's current Linear workspace. One Linear account/workspace per app user
is supported in this version. Other app users have independent grants.

Refresh and revocation use database advisory locks per user to serialize token
rotation across server instances. Access/refresh tokens never reach browser code.
Settings and workspace operations use the same token service; the agent retrieves
tokens over the authenticated internal API and uses Linear's read-only MCP endpoint.
Workspace writes retain destination validation and existing idempotency receipts.

Verification: pnpm typecheck, pnpm lint, pnpm build:agent.
With local dev running: RUN_WORKSPACE_TESTS=1 pnpm exec node --env-file=.env tests/linear-oauth.integration.mjs
The test creates disposable users and verifies PKCE, credential encryption,
cookie/user binding, denial, replay rejection and user isolation without granting
real Linear access. Actual account consent and the Settings test need a user login.

References:
- https://linear.app/developers/oauth-2-0-authentication
- https://linear.app/docs/mcp

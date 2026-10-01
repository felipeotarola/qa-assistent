# Repository maps in Material

Ask: “Be Axel skapa en repokarta för https://github.com/felipeotarola/surdeg
och spara den i Material. Visa webbapp, autentisering, databas och livesändning.”

Axel starts `codex` with `mode: repository_map`, canonical `repositoryUrl`, and
the requested `task`. The existing opt-in subscription worker and isolated VPS
sandbox perform the analysis; no separate agent, database migration or worker
deployment is required. Existing checkout reuse and no install/start/source edits
are explicit job instructions. This mode uses the existing executor permissions,
not a new OS-level read-only sandbox.

The task envelope selects a separate map-result path in the durable setup-job
callback. Maps require valid JSON, matching repository, a full commit and code
references on every node. References are model-reported from source inspection;
schema validation does not independently prove their correctness. Invalid or
truncated reports do not produce a diagram. A transaction and durable evidence
receipt prevent duplicate material on concurrent callbacks or retries, even if
the item is edited or put in trash. Existing storage errors remain retryable by
the setup reconciliation feed. Completed map jobs notify the root chat rather
than the short-lived Axel child session and never trigger app setup or tests.

Maps show the analyzed commit, code links, selectable components, inferred vs
code-supported relationships and a test-proposal action. Standard Material
editing/history preserve metadata. Updating to another commit requires a new
analysis; maps are not live-synced with GitHub.

Verification: `pnpm test:unit`, `pnpm typecheck`, `pnpm lint`, `pnpm build:agent`.
Opt-in API verification: `RUN_WORKSPACE_TESTS=1 node --env-file=.env
tests/diagram.integration.mjs`. A real subscription/VPS test is available in
`tests/repository-map-live.integration.mjs` with `RUN_CODEX_CHAT_TESTS=1`.
It creates and removes its own workspace; `KEEP_MAP_FIXTURE=1` retains it for
manual UI inspection. Never run this test against another user's credentials.
